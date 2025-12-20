import crypto from "node:crypto";

import { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";

import { env } from "../config/env";
import { settingsRepository } from "../repositories/settingsRepository";
import type { EventMapping } from "../types/settings";
import { IdoxxyService } from "../services/idoxxyService";

type MappingResolution = {
  source: "mapping" | "fallback";
  groupIds: string[];
  mapping?: EventMapping;
};

type CustomerPayload = {
  email: string;
  firstName?: string;
  lastName?: string;
};

const idoxxyService = new IdoxxyService();

const customerCreatedSchema = z
  .object({
    idoxxy_path: z.string().min(1).optional(),
    customer: z.object({
      id: z.union([z.string(), z.number()]).transform((value) => String(value)),
      email: z.string().email(),
      first_name: z.string().optional().nullable(),
      last_name: z.string().optional().nullable(),
    }),
  })
  .passthrough();

const orderCreatedSchema = z
  .object({
    idoxxy_path: z.string().min(1).optional(),
    order: z.object({
      id: z.union([z.string(), z.number()]).transform((value) => String(value)),
      email: z.string().email().optional(),
    }),
    customer: z
      .object({
        email: z.string().email().optional(),
        first_name: z.string().optional().nullable(),
        last_name: z.string().optional().nullable(),
      })
      .optional(),
  })
  .passthrough();

const resolvePayloadValue = (payload: unknown, field: string): unknown => {
  if (!payload || typeof payload !== "object") {
    return undefined;
  }

  return field.split(".").reduce<unknown>((current, key) => {
    if (!current || typeof current !== "object") {
      return undefined;
    }

    return (current as Record<string, unknown>)[key];
  }, payload);
};

const matchesCondition = (
  value: unknown,
  condition: EventMapping["conditions"][number],
): boolean => {
  if (condition.operator === "includes") {
    if (Array.isArray(value)) {
      return value.map(String).includes(condition.value);
    }

    if (typeof value === "string") {
      return value.includes(condition.value);
    }

    return false;
  }

  if (condition.operator === "equals") {
    return String(value ?? "") === condition.value;
  }

  if (condition.operator === "not_equals") {
    return String(value ?? "") !== condition.value;
  }

  return false;
};

const mappingMatchesPayload = (mapping: EventMapping, payload: unknown) => {
  if (!mapping.conditions.length) {
    return true;
  }

  return mapping.conditions.every((condition) => {
    const value = resolvePayloadValue(payload, condition.field);
    return matchesCondition(value, condition);
  });
};

const resolveMappingGroups = (
  eventKey: string,
  payload: unknown,
  fallbackGroupIds: string[],
): MappingResolution | null => {
  const snapshot = settingsRepository.getSnapshot();
  const mappings = snapshot.mappings
    .filter((mapping) => mapping.enabled && mapping.event === eventKey)
    .sort((a, b) => a.priority - b.priority);

  const mapping = mappings.find((candidate) => mappingMatchesPayload(candidate, payload));

  if (mapping && mapping.targetGroupIds.length > 0) {
    return {
      source: "mapping",
      groupIds: mapping.targetGroupIds,
      mapping,
    };
  }

  if (fallbackGroupIds.length > 0) {
    return {
      source: "fallback",
      groupIds: fallbackGroupIds,
    };
  }

  return null;
};

const extractCustomerFromOrder = (payload: z.infer<typeof orderCreatedSchema>): CustomerPayload => {
  const email = payload.order.email ?? payload.customer?.email;

  if (!email) {
    throw new Error("Brak adresu email w webhooku zamówienia.");
  }

  return {
    email,
    firstName: payload.customer?.first_name ?? undefined,
    lastName: payload.customer?.last_name ?? undefined,
  };
};

const verifyShoperSignature = (req: Request, res: Response, next: NextFunction) => {
  if (!env.SHOPER_WEBHOOK_SECRET) {
    return next();
  }

  const signatureHeader =
    req.header("X-Shoper-Webhook-Signature") ?? req.header("X-Shoper-Signature");

  if (!signatureHeader) {
    return res.status(401).json({ ok: false, error: "Brak podpisu webhooka." });
  }

  if (!req.rawBody) {
    return res.status(400).json({ ok: false, error: "Brak treści webhooka." });
  }

  const expected = crypto
    .createHmac("sha256", env.SHOPER_WEBHOOK_SECRET)
    .update(req.rawBody)
    .digest("hex");

  const received = signatureHeader.trim();

  if (
    received.length !== expected.length ||
    !crypto.timingSafeEqual(Buffer.from(received), Buffer.from(expected))
  ) {
    return res.status(401).json({ ok: false, error: "Nieprawidłowy podpis webhooka." });
  }

  return next();
};

export const webhooksRouter = Router();

webhooksRouter.post(
  "/shoper/customer-created",
  verifyShoperSignature,
  async (req: Request, res: Response) => {
    const parsed = customerCreatedSchema.safeParse(req.body);

    if (!parsed.success) {
      return res.status(400).json({ ok: false, errors: parsed.error.issues });
    }

    const payload = parsed.data;
    const snapshot = settingsRepository.getSnapshot();
    const resolution = resolveMappingGroups(
      "customer.created",
      payload,
      snapshot.defaultGroupIds.registration,
    );

    if (!resolution) {
      // eslint-disable-next-line no-console
      console.warn("Brak mapowania lub grup domyślnych dla webhooka customer-created.", {
        idoxxyPath: payload.idoxxy_path,
      });
      return res.status(202).json({ ok: false, reason: "no-groups" });
    }

    const customer: CustomerPayload = {
      email: payload.customer.email,
      firstName: payload.customer.first_name ?? undefined,
      lastName: payload.customer.last_name ?? undefined,
    };

    const ensuredCustomer = await idoxxyService.ensureCustomerExists(customer);
    await idoxxyService.addCustomerToGroups(ensuredCustomer.id, resolution.groupIds);

    return res.json({ ok: true, groups: resolution.groupIds, source: resolution.source });
  },
);

webhooksRouter.post(
  "/shoper/order-created",
  verifyShoperSignature,
  async (req: Request, res: Response) => {
    const parsed = orderCreatedSchema.safeParse(req.body);

    if (!parsed.success) {
      return res.status(400).json({ ok: false, errors: parsed.error.issues });
    }

    const payload = parsed.data;
    const snapshot = settingsRepository.getSnapshot();
    const resolution = resolveMappingGroups(
      "order.created",
      payload,
      snapshot.defaultGroupIds.order,
    );

    if (!resolution) {
      // eslint-disable-next-line no-console
      console.warn("Brak mapowania lub grup domyślnych dla webhooka order-created.", {
        idoxxyPath: payload.idoxxy_path,
      });
      return res.status(202).json({ ok: false, reason: "no-groups" });
    }

    let customer: CustomerPayload;

    try {
      customer = extractCustomerFromOrder(payload);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Nieznany błąd webhooka.";
      return res.status(400).json({ ok: false, error: message });
    }

    const ensuredCustomer = await idoxxyService.ensureCustomerExists(customer);
    await idoxxyService.addCustomerToGroups(ensuredCustomer.id, resolution.groupIds);

    return res.json({ ok: true, groups: resolution.groupIds, source: resolution.source });
  },
);
