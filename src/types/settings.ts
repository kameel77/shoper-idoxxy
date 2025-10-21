export type ApiCredentials = {
  apiKey: string;
  clientId: string;
  clientSecret: string;
  baseUrl: string;
};

export type MappingCondition = {
  field: string;
  operator: "equals" | "not_equals" | "includes";
  value: string;
};

export type EventMapping = {
  id: string;
  name: string;
  event: "customer.registered" | "order.paid" | "order.fulfilled" | string;
  priority: number;
  enabled: boolean;
  targetGroupIds: string[];
  documentId?: string;
  conditions: MappingCondition[];
};

export type SettingsSnapshot = {
  credentials?: ApiCredentials;
  defaultGroupIds: {
    registration: string[];
    order: string[];
  };
  mappings: EventMapping[];
  lastSyncedAt?: string;
};
