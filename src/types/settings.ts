export type PathMapping = {
  pathKey: string;
  groupIds: string[];
};

export type EventMappingCondition = {
  field: string;
  operator: "equals" | "not_equals" | "includes";
  value: string;
};

export type EventMapping = {
  id: string | undefined;
  name: string;
  event: string;
  priority: number;
  enabled: boolean;
  targetGroupIds: string[];
  documentId: string | undefined;
  conditions: EventMappingCondition[];
};

export type SyncLogEntry = {
  id: string;
  timestamp: number;
  event: string;
  source: "webhook" | "manual";
  customerId: string | undefined;
  customerEmail: string | undefined;
  orderId: string | undefined;
  shoperCustomerId: string | undefined;
  action: string;
  status: "success" | "error" | "partial";
  details: {
    groupsAssigned: string[] | undefined;
    groupsRemoved: string[] | undefined;
    mappingUsed: string | undefined;
    sourceUsed: "mapping" | "fallback" | undefined;
    error: string | undefined;
  };
  durationMs: number | undefined;
};

export type SettingsSnapshot = {
  shoperApiKey: string | undefined;
  idoxxyApiKey: string | undefined;
  baseUrl: string | undefined;
  credentials: {
    baseUrl: string | undefined;
    apiKey: string | undefined;
  };
  fallbackRegistrationGroupIds: string[];
  fallbackOrderGroupIds: string[];
  pathMappings: PathMapping[];
  defaultGroupIds: {
    registration: string[];
    order: string[];
  };
  mappings: EventMapping[];
  lastSyncedAt: number | undefined;
  lastSettingsModifiedAt: number | undefined;
  syncLogs: SyncLogEntry[];
};
