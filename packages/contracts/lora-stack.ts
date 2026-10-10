/** Bounded workflow policy; actual memory admission can allow fewer adapters. */
export const MAX_LORAS = 32;
/** Catalogs without a published capability retain their previous UI limit. */
export const LEGACY_MAX_LORAS = 4;

export interface LoraChoice { id: string; strength: number }

/** Shared request validation; preserves the caller's explicit adapter order. */
export function validateLoraChoices(value: unknown, maxCount = MAX_LORAS): value is LoraChoice[] {
  if (!Number.isSafeInteger(maxCount) || maxCount < 0 || maxCount > MAX_LORAS || !Array.isArray(value) || value.length > maxCount) return false;
  const ids = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item) || Object.keys(item).length !== 2 || Object.keys(item).some(key => !["id", "strength"].includes(key)) || typeof item.id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/.test(item.id) || ids.has(item.id) || typeof item.strength !== "number" || !Number.isFinite(item.strength) || item.strength < 0 || item.strength > 2) return false;
    ids.add(item.id);
  }
  return true;
}
