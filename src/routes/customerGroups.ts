import { Router, type Request, type Response } from "express";
import { z } from "zod";

import { CustomerGroupsService } from "../services/customerGroupsService";

export const customerGroupsRouter = Router();
const customerGroupsService = new CustomerGroupsService();

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
      const groups = await customerGroupsService.getCustomerGroups(customerId);
      return res.json({ ok: true, groups });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Nieznany błąd pobierania grup";
      return res.status(500).json({ ok: false, error: message });
    }
  },
);

customerGroupsRouter.post(
  "/groups/:groupId/customers/bulk",
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
      const result = await customerGroupsService.assignCustomersToGroup(
        groupId,
        parsed.data.customerIds,
      );
      return res.json({ ok: true, result });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Nieznany błąd przypisania grup";
      return res.status(500).json({ ok: false, error: message });
    }
  },
);
