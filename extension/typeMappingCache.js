const STORAGE_KEY = "typeMappingCache";

async function readCache() {
  const { [STORAGE_KEY]: cache = {} } = await chrome.storage.local.get(STORAGE_KEY);
  return cache;
}

async function writeCache(cache) {
  await chrome.storage.local.set({ [STORAGE_KEY]: cache });
}

export async function resetTypeMappingCache() {
  await writeCache({});
}

export async function getTypeMappingCacheEntry(type) {
  const cache = await readCache();
  return cache[type] ?? null;
}

export async function setTypeMappingCacheEntry(type, { label, axRole, confidence, source, irPathOfOrigin }) {
  const cache = await readCache();
  cache[type] = {
    label,
    axRole,
    confidence,
    source,
    irPathOfOrigin,
    resolvedAt: new Date().toISOString(),
  };
  await writeCache(cache);
}

export async function setNegativeCacheEntry(type, irPathOfOrigin) {
  const cache = await readCache();
  cache[type] = {
    noMappingExists: true,
    irPathOfOrigin,
    resolvedAt: new Date().toISOString(),
  };
  await writeCache(cache);
}

export async function invalidateTypeMappingCacheEntry(type) {
  const cache = await readCache();
  delete cache[type];
  await writeCache(cache);
}