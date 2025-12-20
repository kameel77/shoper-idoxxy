type CacheEntry<T> = {
  value: T;
  expiresAt: number;
};

const CACHE_PREFIX = "idoxxy_groups_cache";
const DEFAULT_TTL_MS = 60 * 60 * 1000;

const cacheStore = new Map<string, CacheEntry<unknown>>();

const buildCacheKey = (customerId: string) =>
  `${CACHE_PREFIX}_${customerId}`;

export const customerGroupsCache = {
  get<T>(customerId: string): T | undefined {
    const key = buildCacheKey(customerId);
    const entry = cacheStore.get(key);

    if (!entry) {
      return undefined;
    }

    if (entry.expiresAt <= Date.now()) {
      cacheStore.delete(key);
      return undefined;
    }

    return entry.value as T;
  },
  set<T>(customerId: string, value: T, ttlMs = DEFAULT_TTL_MS) {
    const key = buildCacheKey(customerId);
    cacheStore.set(key, {
      value,
      expiresAt: Date.now() + ttlMs,
    });
  },
  delete(customerId: string) {
    const key = buildCacheKey(customerId);
    cacheStore.delete(key);
  },
  deleteMany(customerIds: string[]) {
    customerIds.forEach((customerId) => {
      const key = buildCacheKey(customerId);
      cacheStore.delete(key);
    });
  },
  buildCacheKey,
  ttlMs: DEFAULT_TTL_MS,
};
