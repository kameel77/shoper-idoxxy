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
  id?: string;
  name: string;
  event: string;
  priority: number;
  enabled: boolean;
  targetGroupIds: string[];
  documentId?: string;
  conditions: EventMappingCondition[];
};

export type SyncLogEntry = {
  id: string;
  timestamp: number;
  event: string;
  source: "webhook" | "manual";
  customerId?: string;
  customerEmail?: string;
  orderId?: string;
  shoperCustomerId?: string;
  action: string;
  status: "success" | "error" | "partial";
  details: {
    groupsAssigned?: string[];
    groupsRemoved?: string[];
    mappingUsed?: string;
    sourceUsed?: "mapping" | "fallback";
    error?: string;
  };
  durationMs?: number;
};

export type SettingsSnapshot = {
  shoperApiKey?: string | undefined;
  idoxxyApiKey?: string | undefined;
  baseUrl?: string;
  credentials?: {
    baseUrl?: string;
    apiKey?: string;
  };
  fallbackRegistrationGroupIds: string[];
  fallbackOrderGroupIds: string[];
  pathMappings: PathMapping[];
  defaultGroupIds: {
    registration: string[];
    order: string[];
  };
  mappings: EventMapping[];
  lastSyncedAt?: number;
  lastSettingsModifiedAt?: number;
  syncLogs: SyncLogEntry[];
};
