type CacheEntry<T> = {
  value: T;
  expiresAt: number;
};

const CACHE_PREFIX = "idoxxy_groups_cache";
const DEFAULT_TTL_MS = 60 * 60 * 1000;

const cacheStore = new Map<string, CacheEntry<unknown>>();

// Namespaced on shopId as well as customerId: customer ids are only unique
// within a single iDoxxy workspace, so a key on customerId alone would let
// shop A's cached group list for a given id be served straight back to shop
// B asking about "the same" id. Every call site here is expected to pass the
// caller's verified shopId (req.shopId), never a caller-supplied one - see
// src/routes/customerGroups.ts.
const buildCacheKey = (shopId: string, customerId: string) =>
  `${CACHE_PREFIX}_${shopId}_${customerId}`;

export const customerGroupsCache = {
  get<T>(shopId: string, customerId: string): T | undefined {
    const key = buildCacheKey(shopId, customerId);
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
  set<T>(shopId: string, customerId: string, value: T, ttlMs = DEFAULT_TTL_MS) {
    const key = buildCacheKey(shopId, customerId);
    cacheStore.set(key, {
      value,
      expiresAt: Date.now() + ttlMs,
    });
  },
  delete(shopId: string, customerId: string) {
    const key = buildCacheKey(shopId, customerId);
    cacheStore.delete(key);
  },
  // Invalidates only the calling shop's entries for the given customer ids -
  // never another shop's cached data for the same ids.
  deleteMany(shopId: string, customerIds: string[]) {
    customerIds.forEach((customerId) => {
      const key = buildCacheKey(shopId, customerId);
      cacheStore.delete(key);
    });
  },
  buildCacheKey,
  ttlMs: DEFAULT_TTL_MS,
};
