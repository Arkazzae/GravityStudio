# Asset storage

Gravity Studio can keep generated images and uploaded references in a private S3-compatible bucket. [The supplied RustFS deployment](../deploy/rustfs/README.md) runs one local container; an existing compatible S3 service can be configured instead. Local storage remains the default.

SQLite, model weights, worker configuration and ComfyUI working files stay in `GRAVITY_DATA_DIR`. SQLite records each asset's storage location, ownership and integrity information. The browser continues to use authenticated Studio URLs; it does not receive bucket credentials or public object URLs.

## Configuration

Add the following to the installation's private `.env`. Use a dedicated application key with access to the selected bucket and prefix:

```dotenv
GRAVITY_ASSET_STORAGE=s3
GRAVITY_S3_ENDPOINT=http://127.0.0.1:9000
GRAVITY_S3_BUCKET=gravity-studio
GRAVITY_S3_REGION=us-east-1
GRAVITY_S3_PREFIX=media-v1
GRAVITY_S3_ACCESS_KEY_ID=replace-with-your-application-access-key
GRAVITY_S3_SECRET_ACCESS_KEY=replace-with-your-application-secret
# Optional; defaults to 30000 milliseconds, accepts 1000–120000.
GRAVITY_S3_TIMEOUT_MS=30000
```

Keep `.env` readable only by the application account (`chmod 600 .env`). The endpoint must be an HTTPS origin or loopback HTTP, without credentials, a path, query or fragment. Use the same endpoint, region, bucket and prefix after restarting: together they identify the store referenced by SQLite. Rotating access keys does not change that identity.

Initialize and verify the bucket before starting Studio with S3 enabled:

```sh
pnpm storage init
```

`init` creates a missing private bucket when the configured key permits it, then checks writes, full read-back, anonymous access denial and deletion in both asset scopes. For a scoped application key, create the bucket with an administrator first. Startup does not create buckets automatically.

New images and references use the configured primary store. Once an asset has an S3 reference, reads use that object as the source of truth and check its saved size and SHA-256. An unavailable or changed object produces an error; an old local copy is not silently substituted. Existing local assets remain readable until migrated.

## Move existing assets

Stop the Studio application first, including any older version that predates the process lock. Keep RustFS running. Back up the complete Studio data directory and the object store before maintenance.

```sh
systemctl --user stop gravity-studio.service
pnpm storage status
pnpm storage migrate
pnpm storage status
systemctl --user start gravity-studio.service
```

Use your installation's service name. With a manual launch, stop that process instead. All commands load `.env`; append `--data-dir /absolute/path` if selecting a different installation. `status` reports the configured primary store, local/S3 input and output counts and bytes, and pending deletions.

Migration takes an exclusive process lock, refuses active jobs and creates a SQLite backup. It copies each local asset, reads the object back to verify its full content, then updates the database reference. Local source files remain intact. Already migrated objects are verified again, and assets with pending deletion intents are skipped. The result reports `migrated`, `verified`, `skippedDeletions`, `backupPath` and updated counts. If interrupted, resolve the reported problem and rerun while Studio remains stopped.

Retained local files are recovery copies, not an automatic fallback. Keep them through validation and backup; this command does not prune them. Switching `GRAVITY_ASSET_STORAGE` back to `local` is not a rollback: Studio refuses to open a database that still references S3 without its matching object-store configuration. Keep S3 configured, or restore a consistent pre-migration database and its local assets while the application is stopped.

## Backups and access

Back up SQLite and RustFS data as one installation, along with the application's private environment and credential-encryption key. Stop writes while taking a consistent filesystem backup. Model weights can be backed up separately or downloaded again. A single RustFS volume persists across container replacement but does not protect against losing that disk.

Keep the bucket private and route browser requests through Studio. Do not apply expiration rules to the asset prefix: SQLite must remain consistent with the saved objects. Studio's delete operations manage its registered assets and pending object deletions.
