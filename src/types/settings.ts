export type PathMapping = {
  pathKey: string;
  groupIds: string[];
};

export type SettingsSnapshot = {
  shoperApiKey?: string;
  idoxxyApiKey?: string;
  fallbackRegistrationGroupIds: string[];
  fallbackOrderGroupIds: string[];
  pathMappings: PathMapping[];
};
