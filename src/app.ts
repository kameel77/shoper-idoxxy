/// <reference path="./types/express.d.ts" />

import path from "node:path";

import cookieParser from "cookie-parser";
import express, { type Request, type Response } from "express";
import helmet from "helmet";
import morgan from "morgan";
import session from "express-session";

import { env } from "./config/env";
import { userRepository } from "./repositories/userRepository";
import { requireAuth, optionalAuth } from "./middleware/auth";
import { extractShopContext } from "./middleware/shopContext";
import { authRouter } from "./routes/auth";
import { idoxxyAdminRouter } from "./routes/idoxxyAdmin";
import { settingsRouter } from "./routes/settings";
import { customerGroupsRouter } from "./routes/customerGroups";
import { webhooksRouter } from "./routes/webhooks";
import { adminIdoxxyRouter } from "./routes/adminIdoxxy";

export const createApp = () => {
  const app = express();

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'", "'unsafe-inline'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", "data:", "https:"],
          connectSrc: ["'self'"],
          fontSrc: ["'self'", "https:", "data:"],
          objectSrc: ["'none'"],
          mediaSrc: ["'self'"],
          frameSrc: ["'none'"],
        },
      },
    }),
  );

  app.use(cookieParser());
  
  // Session configuration
  app.use(
    session({
      secret: env.SESSION_SECRET,
      resave: false,
      saveUninitialized: false,
      name: "shoper_idoxxy.sid",
      cookie: {
        secure: env.NODE_ENV === "production",
        httpOnly: true,
        maxAge: 24 * 60 * 60 * 1000, // 24 hours
        sameSite: "lax",
      },
    }),
  );

  app.use(
    express.json({
      verify: (req, _res, buf) => {
        (req as Request & { rawBody?: Buffer }).rawBody = buf;
      },
    }),
  );
  app.use(express.urlencoded({ extended: true }));
  app.use(morgan("dev"));

  // Health check - no auth required
  app.get("/health", (_req: Request, res: Response) => {
    res.json({ status: "ok" });
  });

  // Auth routes (login/logout) - no auth required
  app.use("/auth", authRouter);

  // Shop-specific settings - NO auth required
  // Shop admins access these directly from Shoper.pl panel
  // Shop identification comes from headers or query params
  app.use("/settings", extractShopContext, optionalAuth, settingsRouter);
  app.use("/admin/idoxxy", extractShopContext, optionalAuth, idoxxyAdminRouter);
  app.use("/admin/idoxxy", extractShopContext, optionalAuth, adminIdoxxyRouter);
  app.use("/customers", extractShopContext, optionalAuth, customerGroupsRouter);

  // Public static files - but protect admin folder
  app.use("/admin", requireAuth, express.static(path.join(process.cwd(), "public", "admin")));
  app.use(express.static(path.join(process.cwd(), "public")));
  
  // Webhooks don't require auth (they use signature verification)
  app.use("/webhooks", webhooksRouter);

  // Redirect root based on auth status
  app.get("/", optionalAuth, (req: Request, res: Response) => {
    if (req.user) {
      // Admin is logged in - show dashboard
      res.redirect("/admin/dashboard.html");
    } else {
      // Shop admin from Shoper - show settings or start page
      const shopId = req.query.shopId || req.headers["x-shoper-shop-id"];
      if (shopId) {
        res.redirect(`/settings?shopId=${shopId}`);
      } else {
        // No shop context - could be start page or login
        res.sendFile(path.join(process.cwd(), "public", "index.html"));
      }
    }
  });

  // Create default admin user on startup
  userRepository.createDefaultAdminIfNotExists().catch((error) => {
    console.error("[App] Failed to create default admin:", error);
  });

  return app;
};
