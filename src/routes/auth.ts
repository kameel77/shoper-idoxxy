import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { userRepository } from "../repositories/userRepository";
import { requireApiAuth } from "../middleware/auth";

export const authRouter = Router();

const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(6),
});

// POST /auth/login
authRouter.post("/login", async (req: Request, res: Response) => {
  const parsed = loginSchema.safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({
      ok: false,
      error: "Nieprawidłowe dane logowania",
    });
  }

  const { username, password } = parsed.data;

  try {
    const user = userRepository.getByUsername(username);

    if (!user) {
      return res.status(401).json({
        ok: false,
        error: "Nieprawidłowa nazwa użytkownika lub hasło",
      });
    }

    const isValidPassword = await userRepository.validatePassword(user, password);

    if (!isValidPassword) {
      return res.status(401).json({
        ok: false,
        error: "Nieprawidłowa nazwa użytkownika lub hasło",
      });
    }

    // Update last login
    userRepository.updateLastLogin(user.id);

    // Set session
    const session = (req as any).session;
    if (session) {
      session.userId = user.id;
      session.isAuthenticated = true;
    }

    return res.json({
      ok: true,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        role: user.role,
      },
    });
  } catch (error) {
    console.error("[Auth] Login error:", error);
    return res.status(500).json({
      ok: false,
      error: "Błąd podczas logowania",
    });
  }
});

// POST /auth/logout
authRouter.post("/logout", (req: Request, res: Response) => {
  const session = (req as any).session;
  if (session?.destroy) {
    session.destroy((err: any) => {
      if (err) {
        console.error("[Auth] Logout error:", err);
        return res.status(500).json({ ok: false, error: "Błąd podczas wylogowania" });
      }
      res.clearCookie("connect.sid");
      return res.json({ ok: true });
    });
  } else {
    return res.json({ ok: true });
  }
});

// GET /auth/me - get current user
authRouter.get("/me", async (req: Request, res: Response) => {
  const session = (req as any).session as { userId?: string; isAuthenticated?: boolean } | undefined;
  
  if (!session?.userId || !session?.isAuthenticated) {
    return res.status(401).json({ ok: false, error: "Niezalogowany" });
  }

  const user = userRepository.getById(session.userId);
  
  if (!user || !user.isActive) {
    return res.status(401).json({ ok: false, error: "Użytkownik nieaktywny" });
  }

  return res.json({
    ok: true,
    user: {
      id: user.id,
      username: user.username,
      email: user.email,
      role: user.role,
    },
  });
});

// POST /auth/change-password - change password (requires auth)
authRouter.post("/change-password", requireApiAuth, async (req: Request, res: Response) => {
  const parsed = changePasswordSchema.safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({
      ok: false,
      error: "Nieprawidłowe dane",
      details: parsed.error.issues,
    });
  }

  const { currentPassword, newPassword } = parsed.data;
  const user = req.user!;

  try {
    // Verify current password
    const isValidPassword = await userRepository.validatePassword(user, currentPassword);
    
    if (!isValidPassword) {
      return res.status(401).json({
        ok: false,
        error: "Nieprawidłowe obecne hasło",
      });
    }

    // Update password
    await userRepository.updatePassword(user.id, newPassword);

    return res.json({
      ok: true,
      message: "Hasło zostało zmienione",
    });
  } catch (error) {
    console.error("[Auth] Change password error:", error);
    return res.status(500).json({
      ok: false,
      error: "Błąd podczas zmiany hasła",
    });
  }
});
