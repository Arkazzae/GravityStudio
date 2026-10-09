import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ApiError, type IntegrationCredential, type IntegrationProviderId } from "../../packages/contracts/index.ts";
import type { Store } from "./store.ts";

interface CredentialRow {
  provider: IntegrationProviderId;
  version: number;
  ciphertext: Uint8Array;
  iv: Uint8Array;
  tag: Uint8Array;
  suffix: string;
  updated_at: string;
}
const providers = new Set<IntegrationProviderId>(["huggingface", "civitai", "gemini", "openai", "anthropic", "nanogpt"]);
const unreadable = () => new ApiError(503, "CREDENTIALS_UNREADABLE", "Saved integration credentials could not be unlocked. Check the original credentials key and storage.");
const unavailable = () => new ApiError(503, "CREDENTIALS_KEY_UNAVAILABLE", "Integration credentials key is unavailable or invalid. Use a base64-encoded 32-byte key or restore the private credentials.key file.");

function providerId(provider: IntegrationProviderId) {
  if (!providers.has(provider)) throw new ApiError(400, "INVALID_INTEGRATION", "Choose a supported integration.");
}
function apiKeyValue(value: unknown): string {
  if (typeof value !== "string") throw new ApiError(400, "INVALID_API_KEY", "Enter an API key containing 8–4096 characters without spaces.");
  const key = value.trim();
  if (!/^[\x21-\x7e]{8,4096}$/.test(key)) throw new ApiError(400, "INVALID_API_KEY", "Enter an API key containing 8–4096 characters without spaces.");
  return key;
}
function keyFromBase64(value: string): Buffer {
  if (!/^[A-Za-z0-9+/]{43}=$/.test(value)) throw unavailable();
  const key = Buffer.from(value, "base64");
  if (key.length !== 32 || key.toString("base64") !== value) throw unavailable();
  return key;
}
function aad(row: Pick<CredentialRow, "provider" | "suffix" | "updated_at">): Buffer {
  return Buffer.from(JSON.stringify(["gravity:integration-credential", 1, row.provider, row.suffix, row.updated_at]));
}
function publicCredential(row: CredentialRow): IntegrationCredential {
  if (typeof row.suffix !== "string" || typeof row.updated_at !== "string" || !/^[\x21-\x7e]{4}$/.test(row.suffix) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(row.updated_at)) throw unreadable();
  return { suffix: row.suffix, updatedAt: row.updated_at };
}

/** Server-only secrets. Public callers receive the suffix and save time, never the key. */
export class CredentialVault {
  private store: Store;
  private configuredKey: string | undefined;
  private loadedKey: Buffer | undefined;

  constructor(store: Store, options: { key?: string } = {}) {
    this.store = store;
    this.configuredKey = options.key;
    try {
      this.store.db.exec(`CREATE TABLE IF NOT EXISTS integration_credentials (
        provider TEXT PRIMARY KEY,
        version INTEGER NOT NULL,
        ciphertext BLOB NOT NULL,
        iv BLOB NOT NULL,
        tag BLOB NOT NULL,
        suffix TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`);
    } catch { throw unreadable(); }
  }

  set(provider: IntegrationProviderId, apiKey: unknown): IntegrationCredential {
    providerId(provider);
    const value = apiKeyValue(apiKey);
    let transaction = false;
    try {
      this.store.db.exec("BEGIN IMMEDIATE");
      transaction = true;
      // This lock also serializes first-run key creation between server processes.
      const key = this.masterKey();
      for (const row of this.store.db.prepare("SELECT * FROM integration_credentials").all() as unknown as CredentialRow[]) this.decrypt(row, key);
      const record = { provider, suffix: value.slice(-4), updated_at: new Date().toISOString() };
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      cipher.setAAD(aad(record));
      const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
      this.store.db.prepare(`INSERT INTO integration_credentials(provider,version,ciphertext,iv,tag,suffix,updated_at) VALUES(?,1,?,?,?,?,?)
        ON CONFLICT(provider) DO UPDATE SET version=excluded.version,ciphertext=excluded.ciphertext,iv=excluded.iv,tag=excluded.tag,suffix=excluded.suffix,updated_at=excluded.updated_at`)
        .run(provider, ciphertext, iv, cipher.getAuthTag(), record.suffix, record.updated_at);
      this.store.db.exec("COMMIT");
      transaction = false;
      return { suffix: record.suffix, updatedAt: record.updated_at };
    } catch (error) {
      if (transaction) {
        try { this.store.db.exec("ROLLBACK"); } catch { /* Preserve the sanitized original failure. */ }
      }
      if (error instanceof ApiError) throw error;
      throw unreadable();
    }
  }

  get(provider: IntegrationProviderId): string | undefined {
    providerId(provider);
    const row = this.row(provider);
    return row ? this.decrypt(row, this.masterKey()) : undefined;
  }

  status(provider: IntegrationProviderId): IntegrationCredential | null {
    providerId(provider);
    const row = this.row(provider);
    return row ? publicCredential(row) : null;
  }

  delete(provider: IntegrationProviderId): void {
    providerId(provider);
    try { this.store.db.prepare("DELETE FROM integration_credentials WHERE provider=?").run(provider); }
    catch { throw unreadable(); }
  }

  private row(provider: IntegrationProviderId): CredentialRow | undefined {
    try { return this.store.db.prepare("SELECT * FROM integration_credentials WHERE provider=?").get(provider) as unknown as CredentialRow | undefined; }
    catch { throw unreadable(); }
  }

  private decrypt(row: CredentialRow, key: Buffer): string {
    try {
      publicCredential(row);
      if (!providers.has(row.provider) || row.version !== 1 || row.iv.length !== 12 || row.tag.length !== 16 || row.ciphertext.length < 8 || row.ciphertext.length > 4096) throw unreadable();
      const decipher = createDecipheriv("aes-256-gcm", key, row.iv);
      decipher.setAAD(aad(row));
      decipher.setAuthTag(row.tag);
      const value = Buffer.concat([decipher.update(row.ciphertext), decipher.final()]).toString("utf8");
      if (!/^[\x21-\x7e]{8,4096}$/.test(value) || value.slice(-4) !== row.suffix) throw unreadable();
      return value;
    } catch { throw unreadable(); }
  }

  private masterKey(): Buffer {
    if (this.loadedKey) return this.loadedKey;
    try {
      const configured = this.configuredKey ?? process.env.GRAVITY_CREDENTIALS_KEY;
      if (configured !== undefined) this.loadedKey = keyFromBase64(configured);
      else {
        const path = join(this.store.directory, "credentials.key");
        try { this.loadedKey = this.readPrivateKey(path); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          // Never create a replacement that would orphan existing encrypted records.
          if (this.store.db.prepare("SELECT 1 FROM integration_credentials LIMIT 1").get()) throw unavailable();
          let fd: number;
          try { fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
          catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
            this.loadedKey = this.readPrivateKey(path);
            return this.loadedKey;
          }
          try {
            const key = randomBytes(32);
            writeFileSync(fd, key);
            fsyncSync(fd);
            this.loadedKey = key;
          } finally { closeSync(fd); }
        }
      }
      return this.loadedKey;
    } catch { throw unavailable(); }
  }

  private readPrivateKey(path: string): Buffer {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0 || stat.size !== 32) throw unavailable();
      const key = readFileSync(fd);
      if (key.length !== 32) throw unavailable();
      return key;
    } finally { closeSync(fd); }
  }
}
