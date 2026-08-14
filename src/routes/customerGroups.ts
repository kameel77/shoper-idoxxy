import { Router, type Request, type Response } from "express";
import { z } from "zod";

import { CustomerGroupsService } from "../services/customerGroupsService";
import { requireShopSession, requireCsrf } from "../middleware/shopSession";
import { resolveShopClient } from "../middleware/resolveShopClient";

export const customerGroupsRouter = Router();

// Customer/group data is per-shop - require a verified shop session.
customerGroupsRouter.use(requireShopSession);

const firstParam = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? value[0] : value;

const bulkAssignSchema = z.object({
  customerIds: z.array(z.string().uuid()).min(1),
});

customerGroupsRouter.get(
  "/:customerId/groups",
  async (req: Request, res: Response) => {
    const customerId = firstParam(req.params.customerId);

    if (!customerId) {
      return res.status(400).json({ ok: false, error: "Brak identyfikatora klienta" });
    }

    try {
      // Resolved fresh per request from the verified session's shop (see
      // src/middleware/resolveShopClient.ts) - never a module-level
      // singleton, so this can never silently fall back to a platform-wide
      // client. Throws a statusCode-428 error when the shop has no linked
      // iDoxxy token (see src/services/idoxxyService.ts getClientForShop),
      // handled below the same way src/routes/settings.ts's /groups and
      // /documents do.
      const client = resolveShopClient(req);
      const customerGroupsService = new CustomerGroupsService(req.shopId!, client);
      const groups = await customerGroupsService.getCustomerGroups(customerId);
      return res.json({ ok: true, groups });
    } catch (error) {
      const statusCode = (error as any)?.statusCode;
      const message =
        error instanceof Error ? error.message : "Nieznany błąd pobierania grup";
      return res.status(statusCode || 500).json({ ok: false, error: message });
    }
  },
);

customerGroupsRouter.post(
  "/groups/:groupId/customers/bulk",
  requireCsrf,
  async (req: Request, res: Response) => {
    const groupId = firstParam(req.params.groupId);
    const parsed = bulkAssignSchema.safeParse(req.body);

    if (!groupId) {
      return res.status(400).json({ ok: false, error: "Brak identyfikatora grupy" });
    }

    if (!parsed.success) {
      return res.status(400).json({ ok: false, errors: parsed.error.issues });
    }

    try {
      const client = resolveShopClient(req);
      const customerGroupsService = new CustomerGroupsService(req.shopId!, client);
      const result = await customerGroupsService.assignCustomersToGroup(
        groupId,
        parsed.data.customerIds,
      );
      return res.json({ ok: true, result });
    } catch (error) {
      const statusCode = (error as any)?.statusCode;
      const message =
        error instanceof Error ? error.message : "Nieznany błąd przypisania grup";
      return res.status(statusCode || 500).json({ ok: false, error: message });
    }
  },
);
