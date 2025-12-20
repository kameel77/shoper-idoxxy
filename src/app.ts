/// <reference path="./types/express.d.ts" />

import path from "node:path";

import express, { type Request, type Response } from "express";
import helmet from "helmet";
import morgan from "morgan";

import { idoxxyAdminRouter } from "./routes/idoxxyAdmin";
import { settingsRouter } from "./routes/settings";
import { customerGroupsRouter } from "./routes/customerGroups";
import { webhooksRouter } from "./routes/webhooks";

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
  app.use(
    express.json({
      verify: (req, _res, buf) => {
        (req as Request & { rawBody?: Buffer }).rawBody = buf;
      },
    }),
  );
  app.use(express.urlencoded({ extended: true }));
  app.use(morgan("dev"));
  app.use(express.static(path.join(process.cwd(), "public")));

  app.get("/health", (_req: Request, res: Response) => {
    res.json({ status: "ok" });
  });

  app.use("/settings", settingsRouter);
  app.use("/admin/idoxxy", idoxxyAdminRouter);
  app.use("/customers", customerGroupsRouter);
  app.use("/webhooks", webhooksRouter);

  return app;
};
