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
  id: string;
  name: string;
  event: string;
  priority: number;
  enabled: boolean;
  targetGroupIds: string[];
  documentId?: string;
  conditions: EventMappingCondition[];
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
};
