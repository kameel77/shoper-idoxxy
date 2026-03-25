import type { Request, Response, NextFunction } from "express";
import { userRepository, type User } from "../repositories/userRepository";

// Extend Express Request to include user
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: User;
    }
  }
}

// Custom session interface
interface AuthSession {
  userId?: string;
  isAuthenticated?: boolean;
}

// Helper to get typed session
const getAuthSession = (req: Request): AuthSession | undefined => {
  return (req as any).session as AuthSession | undefined;
};

export const requireAuth = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  const session = getAuthSession(req);
  const userId = session?.userId;

  if (!userId || !session?.isAuthenticated) {
    if (req.path.startsWith("/api/") || req.path.startsWith("/admin/")) {
      res.status(401).json({ ok: false, error: "Wymagane zalogowanie" });
      return;
    }
    // For HTML pages, redirect to login
    res.redirect("/login.html");
    return;
  }

  const user = userRepository.getById(userId);
  if (!user || !user.isActive) {
    const expressReq = req as any;
    if (expressReq.session?.destroy) {
      expressReq.session.destroy(() => {});
    }
    if (req.path.startsWith("/api/") || req.path.startsWith("/admin/")) {
      res.status(401).json({ ok: false, error: "Użytkownik nieaktywny" });
      return;
    }
    res.redirect("/login.html");
    return;
  }

  req.user = user;
  next();
};

export const requireApiAuth = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  const session = getAuthSession(req);
  const userId = session?.userId;

  if (!userId || !session?.isAuthenticated) {
    res.status(401).json({ ok: false, error: "Wymagane zalogowanie" });
    return;
  }

  const user = userRepository.getById(userId);
  if (!user || !user.isActive) {
    const expressReq = req as any;
    if (expressReq.session?.destroy) {
      expressReq.session.destroy(() => {});
    }
    res.status(401).json({ ok: false, error: "Użytkownik nieaktywny" });
    return;
  }

  req.user = user;
  next();
};

// Optional auth - attaches user if logged in, but doesn't require it
export const optionalAuth = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  const session = getAuthSession(req);
  const userId = session?.userId;

  if (userId && session?.isAuthenticated) {
    const user = userRepository.getById(userId);
    if (user && user.isActive) {
      req.user = user;
    }
  }

  next();
};
