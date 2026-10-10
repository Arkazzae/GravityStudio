import { AVATAR_THEME_IDS, type AccountProfile, type AvatarThemeId } from "../../packages/contracts/account.ts";
import { ApiError, type Owner } from "../../packages/contracts/index.ts";
import type { Store } from "./store.ts";
import { requireActiveUser } from "./administration.ts";

const fields = new Set(["revision", "displayName", "workspaceName", "avatarTheme"]);
const unavailable = () => new ApiError(503, "ACCOUNT_UNAVAILABLE", "Account preferences are unavailable. Try again shortly.");

function accountName(value: unknown, label: string): string {
  if (typeof value !== "string" || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) throw new ApiError(400, "INVALID_ACCOUNT", `Use 1–64 characters without control characters for the ${label}.`);
  const name = value.trim();
  if (!name || name.length > 64) throw new ApiError(400, "INVALID_ACCOUNT", `Use 1–64 characters for the ${label}.`);
  return name;
}

function validateAccount(value: unknown): AccountProfile {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ApiError(400, "INVALID_ACCOUNT", "Supply your account preferences as an object.");
  const body = value as Record<string, unknown>;
  const keys = Object.keys(body);
  if (keys.length !== fields.size || keys.some(key => !fields.has(key))) throw new ApiError(400, "INVALID_ACCOUNT", "Supply only revision, displayName, workspaceName and avatarTheme.");
  if (typeof body.revision !== "number" || !Number.isSafeInteger(body.revision) || body.revision < 0) throw new ApiError(400, "INVALID_ACCOUNT", "Supply a valid account revision. Reload your account preferences before saving.");
  if (typeof body.avatarTheme !== "string" || !AVATAR_THEME_IDS.includes(body.avatarTheme as AvatarThemeId)) throw new ApiError(400, "INVALID_ACCOUNT", "Choose a supported avatar color.");
  return {
    revision: body.revision,
    displayName: accountName(body.displayName, "display name"),
    workspaceName: accountName(body.workspaceName, "workspace name"),
    avatarTheme: body.avatarTheme as AvatarThemeId,
  };
}

export function accountView(store: Store, owner: Owner): AccountProfile {
  try {
    const saved = store.metadata<unknown>(`account:${owner.id}`);
    return saved === undefined ? { revision: 0, displayName: owner.username, workspaceName: "Personal workspace", avatarTheme: "studio" } : validateAccount(saved);
  } catch { throw unavailable(); }
}

export function saveAccount(store: Store, owner: Owner, value: unknown): AccountProfile {
  const proposed = validateAccount(value);
  let transaction = false;
  try {
    store.db.exec("BEGIN IMMEDIATE");
    transaction = true;
    requireActiveUser(store.db, owner.id);
    const current = accountView(store, owner);
    if (current.revision !== proposed.revision) throw new ApiError(409, "ACCOUNT_CHANGED", "Your account preferences changed in another window. Reload before saving.");
    if (current.revision === Number.MAX_SAFE_INTEGER) throw unavailable();
    const saved = { ...proposed, revision: current.revision + 1 };
    store.setMetadata(`account:${owner.id}`, saved);
    store.db.exec("COMMIT");
    transaction = false;
    return saved;
  } catch (error) {
    if (transaction) {
      try { store.db.exec("ROLLBACK"); } catch { /* Preserve the sanitized failure. */ }
    }
    if (error instanceof ApiError) throw error;
    throw unavailable();
  }
}
