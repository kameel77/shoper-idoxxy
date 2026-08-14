import { randomUUID } from "node:crypto";
import bcrypt from "bcrypt";
import { db } from "../config/database";
import { env, isProduction } from "../config/env";

const SALT_ROUNDS = 10;

/**
 * Developer-only fallback password for the bootstrapped admin account, used
 * only when ADMIN_PASSWORD is unset AND NODE_ENV !== "production" (src/config/env.ts
 * refuses to boot in production without a strong ADMIN_PASSWORD, so this
 * branch is unreachable there). This is the same historic value the account
 * used to be hardcoded to - kept for continuity of local dev workflows and,
 * not incidentally, as the exact value bootstrapAdminAccount() checks
 * existing production accounts against below (see its doc comment).
 *
 * NEVER log this constant or any password derived from it - see
 * bootstrapAdminAccount()'s warnings, which intentionally omit the value.
 */
const DEV_ONLY_DEFAULT_ADMIN_PASSWORD = "admin123";

export type User = {
  id: string;
  username: string;
  email: string;
  passwordHash: string;
  role: string;
  isActive: boolean;
  lastLoginAt: number | undefined;
  createdAt: number;
  updatedAt: number;
};

// Prepared statements
const getUserByUsernameStmt = db.prepare("SELECT * FROM users WHERE username = ? AND is_active = 1");
const getUserByEmailStmt = db.prepare("SELECT * FROM users WHERE email = ? AND is_active = 1");
const getUserByIdStmt = db.prepare("SELECT * FROM users WHERE id = ?");
const insertUserStmt = db.prepare(`
  INSERT INTO users (id, username, email, password_hash, role, is_active, last_login_at, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const updateLastLoginStmt = db.prepare("UPDATE users SET last_login_at = ?, updated_at = ? WHERE id = ?");
const updatePasswordStmt = db.prepare("UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?");
const getAllUsersStmt = db.prepare("SELECT * FROM users ORDER BY created_at DESC");

class UserRepository {
  private rowToUser(row: any): User {
    return {
      id: row.id,
      username: row.username,
      email: row.email,
      passwordHash: row.password_hash,
      role: row.role,
      isActive: row.is_active === 1,
      lastLoginAt: row.last_login_at || undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  async createUser(data: {
    username: string;
    email: string;
    password: string;
    role?: string;
  }): Promise<User> {
    const passwordHash = await bcrypt.hash(data.password, SALT_ROUNDS);
    const now = Date.now();
    const id = randomUUID();

    insertUserStmt.run(
      id,
      data.username,
      data.email,
      passwordHash,
      data.role || "admin",
      1,
      null,
      now,
      now
    );

    const user = this.getById(id);
    if (!user) {
      throw new Error("Failed to create user");
    }
    return user;
  }

  getByUsername(username: string): User | undefined {
    const row = getUserByUsernameStmt.get(username);
    if (!row) return undefined;
    return this.rowToUser(row);
  }

  getByEmail(email: string): User | undefined {
    const row = getUserByEmailStmt.get(email);
    if (!row) return undefined;
    return this.rowToUser(row);
  }

  getById(id: string): User | undefined {
    const row = getUserByIdStmt.get(id);
    if (!row) return undefined;
    return this.rowToUser(row);
  }

  async validatePassword(user: User, password: string): Promise<boolean> {
    return bcrypt.compare(password, user.passwordHash);
  }

  updateLastLogin(userId: string): void {
    const now = Date.now();
    updateLastLoginStmt.run(now, now, userId);
  }

  async updatePassword(userId: string, newPassword: string): Promise<void> {
    const passwordHash = await bcrypt.hash(newPassword, SALT_ROUNDS);
    const now = Date.now();
    updatePasswordStmt.run(passwordHash, now, userId);
  }

  getAllUsers(): User[] {
    const rows = getAllUsersStmt.all() as any[];
    return rows.map(row => this.rowToUser(row));
  }

  /**
   * Bootstrap (or validate) the operator/admin account from
   * ADMIN_USERNAME/ADMIN_PASSWORD (src/config/env.ts). Runs synchronously
   * (bcrypt's *Sync API, not bcrypt.hash/compare) specifically so a
   * production-only failure here can throw synchronously out of createApp()
   * (src/app.ts) and abort startup before app.listen() is ever reached -
   * the same fail-fast posture as the SESSION_SECRET/SHOPER_WEBHOOK_SECRET/
   * TOKEN_ENCRYPTION_KEY checks in src/config/env.ts, just one layer later
   * because this one needs a database read, not just an env var read.
   *
   * Ordering, both deliberate:
   *  1. In production, refuse to start if ANY active admin-role account
   *     still holds the historic hardcoded default password ("admin123").
   *     This is independent of ADMIN_USERNAME/ADMIN_PASSWORD and of whether
   *     this function would create a new account this run - it exists
   *     specifically to catch a deployment that already has that weak
   *     account from before this change, which setting ADMIN_PASSWORD alone
   *     would not fix (this function never overwrites an existing account's
   *     password - see step 2).
   *  2. If a user with ADMIN_USERNAME already exists, leave it untouched -
   *     never silently overwrite an existing admin's password on boot.
   *     Otherwise create it with ADMIN_PASSWORD (or, outside production
   *     only, DEV_ONLY_DEFAULT_ADMIN_PASSWORD - env.ts already refuses to
   *     boot in production without a strong ADMIN_PASSWORD, so the
   *     production branch never falls through to the dev fallback).
   *
   * Never logs a password, hash, or session/token value - see the two
   * console.log calls this replaced, which used to print the plaintext
   * default password.
   */
  bootstrapAdminAccount(): void {
    if (isProduction) {
      const legacyDefaultPasswordStillInUse = this.getAllUsers().some(
        (user) =>
          user.role === "admin" &&
          user.isActive &&
          bcrypt.compareSync(DEV_ONLY_DEFAULT_ADMIN_PASSWORD, user.passwordHash),
      );
      if (legacyDefaultPasswordStillInUse) {
        throw new Error(
          "Wykryto aktywne konto administratora nadal używające domyślnego hasła z poprzedniej wersji aplikacji. " +
            "Ze względów bezpieczeństwa aplikacja NIE uruchomi się w środowisku produkcyjnym, dopóki hasło tego konta " +
            "nie zostanie zmienione (zaloguj się i użyj POST /auth/change-password, albo zaktualizuj password_hash " +
            "bezpośrednio w bazie danych) - samo ustawienie ADMIN_PASSWORD tego nie naprawi, ponieważ istniejące " +
            "konto nigdy nie jest nadpisywane przy starcie.",
        );
      }
    }

    const existingConfiguredAdmin = this.getByUsername(env.ADMIN_USERNAME);
    if (existingConfiguredAdmin) {
      // Already bootstrapped in a previous run (or created/renamed by an
      // operator) - never overwrite its password here.
      return;
    }

    const usingDevFallbackPassword = !env.ADMIN_PASSWORD;
    const password = env.ADMIN_PASSWORD ?? DEV_ONLY_DEFAULT_ADMIN_PASSWORD;
    const passwordHash = bcrypt.hashSync(password, SALT_ROUNDS);
    const now = Date.now();

    insertUserStmt.run(
      randomUUID(),
      env.ADMIN_USERNAME,
      `${env.ADMIN_USERNAME}@shoper-idoxxy.local`,
      passwordHash,
      "admin",
      1,
      null,
      now,
      now,
    );

    if (usingDevFallbackPassword) {
      console.warn(
        `[UserRepository] Utworzono konto administratora "${env.ADMIN_USERNAME}" z domyślnym hasłem deweloperskim ` +
          "(nigdy nie logowanym). To dopuszczalne wyłącznie poza produkcją - ustaw ADMIN_PASSWORD przed wdrożeniem produkcyjnym.",
      );
    } else {
      console.log(`[UserRepository] Utworzono konto administratora "${env.ADMIN_USERNAME}" na podstawie ADMIN_USERNAME/ADMIN_PASSWORD.`);
    }
  }
}

export const userRepository = new UserRepository();
