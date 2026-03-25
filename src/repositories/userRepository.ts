import { randomUUID } from "node:crypto";
import bcrypt from "bcrypt";
import { db } from "../config/database";

const SALT_ROUNDS = 10;

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

  async createDefaultAdminIfNotExists(): Promise<void> {
    const existingAdmin = this.getByUsername("admin");
    if (existingAdmin) {
      return;
    }

    const defaultPassword = "admin123"; // This should be changed on first login
    await this.createUser({
      username: "admin",
      email: "admin@shoper-idoxxy.local",
      password: defaultPassword,
      role: "admin",
    });

    console.log("[UserRepository] Default admin user created (username: admin, password: admin123)");
    console.log("[UserRepository] IMPORTANT: Please change the default password after first login!");
  }
}

export const userRepository = new UserRepository();
