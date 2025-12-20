import path from "node:path";

import express, { type Request, type Response } from "express";
import helmet from "helmet";
import morgan from "morgan";

import { settingsRouter } from "./routes/settings";
import { webhooksRouter } from "./routes/webhooks";

export const createApp = () => {
  const app = express();

  app.use(helmet());
  app.use(
    express.json({
      verify: (req, _res, buf) => {
        req.rawBody = buf;
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
  app.use("/webhooks", webhooksRouter);

  return app;
};
