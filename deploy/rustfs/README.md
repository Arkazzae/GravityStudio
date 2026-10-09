# Private RustFS storage

This recipe runs one RustFS container for image outputs and reference images. It pins the official [RustFS 1.0.1 release](https://github.com/rustfs/rustfs/releases/tag/1.0.1) by its multi-platform image digest; `runtime.lock.json` records the Linux AMD64 and ARM64 manifests. The S3 API and administration console bind only to `127.0.0.1`, on ports 9000 and 9001. Choose Docker **or** Podman on a host.

The application connects from the host. Read [asset storage](../../docs/storage.md) for application configuration and migration. This single-node deployment keeps objects across container replacements; back up its volume separately from SQLite.

## Create credentials

Run from the repository as the account that manages this installation. Choose a persistent secrets directory outside release checkouts:

```sh
export GRAVITY_RUSTFS_SECRETS_DIR="$HOME/.local/share/gravity-studio/rustfs/secrets"
sh deploy/rustfs/prepare-secrets.sh "$GRAVITY_RUSTFS_SECRETS_DIR"
```

The script generates a random administration key pair without printing it and refuses to overwrite existing credentials. Store the pair in your password manager for console access. Keep the directory at mode `0700`: its files use `0444` so container UID `10001` can read Docker Compose's file-backed secrets. Compose does not remap ownership for these mounts. [Docker secret permissions](https://docs.docker.com/reference/compose-file/services/#secrets) explain this limitation.

Both recipes pass only file paths through `RUSTFS_ACCESS_KEY_FILE` and `RUSTFS_SECRET_KEY_FILE`. Missing or empty files stop RustFS; no default credential is supplied. See [RustFS credential handling](https://docs.rustfs.com/en/operations/credentials).

## Docker Compose

Create the named volume once, then launch the single service:

```sh
docker volume create gravity-studio-rustfs-data
docker compose -f deploy/rustfs/compose.yaml config --quiet
docker compose -f deploy/rustfs/compose.yaml up -d --wait
curl --fail http://127.0.0.1:9000/health/ready
```

The volume is external to Compose, so replacing this deployment does not recreate it. The official image initializes `/data` for UID `10001`. A custom bind mount needs ownership matching that container user. [RustFS Docker installation](https://docs.rustfs.com/en/installation/container/docker) covers host-directory permissions.

## Rootless Podman

Use the same unprivileged account for these commands and the user service. Create engine-managed copies of the credentials, owned by UID `10001` inside the container:

```sh
podman volume create gravity-studio-rustfs-data
podman secret create gravity-rustfs-access-key "$GRAVITY_RUSTFS_SECRETS_DIR/access_key"
podman secret create gravity-rustfs-secret-key "$GRAVITY_RUSTFS_SECRETS_DIR/secret_key"
podman pull docker.io/rustfs/rustfs@sha256:1803faef57627e2d9c2e7d89d655d712ddded5389040054987163043fecb6a3c
podman run -d \
  --name gravity-studio-rustfs \
  --user 10001:10001 \
  --read-only --cap-drop ALL --security-opt no-new-privileges \
  --stop-timeout 60 \
  -p 127.0.0.1:9000:9000 -p 127.0.0.1:9001:9001 \
  -v gravity-studio-rustfs-data:/data \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=64m,mode=1777 \
  --secret gravity-rustfs-access-key,target=rustfs_access_key,uid=10001,gid=10001,mode=0400 \
  --secret gravity-rustfs-secret-key,target=rustfs_secret_key,uid=10001,gid=10001,mode=0400 \
  -e RUSTFS_ACCESS_KEY_FILE=/run/secrets/rustfs_access_key \
  -e RUSTFS_SECRET_KEY_FILE=/run/secrets/rustfs_secret_key \
  -e RUSTFS_ADDRESS=:9000 -e RUSTFS_CONSOLE_ADDRESS=:9001 \
  -e RUSTFS_CONSOLE_ENABLE=true \
  -e RUSTFS_CONSOLE_CORS_ALLOWED_ORIGINS=http://127.0.0.1:9001,http://localhost:9001 \
  -e RUSTFS_OBS_LOGGER_LEVEL=warn -e RUSTFS_OBS_LOG_DIRECTORY= \
  --health-cmd 'curl --fail --silent --show-error http://127.0.0.1:9000/health/ready' \
  --health-interval 15s --health-timeout 5s --health-retries 5 --health-start-period 30s \
  docker.io/rustfs/rustfs@sha256:1803faef57627e2d9c2e7d89d655d712ddded5389040054987163043fecb6a3c \
  rustfs /data
curl --fail http://127.0.0.1:9000/health/ready
```

Startup can take a few seconds; retry the health check until it succeeds. Named volumes avoid changing host-directory ownership. Podman's [secret mount options](https://docs.podman.io/en/v4.9.3/markdown/podman-run.1.html#secret-secret-opt-opt) set the in-container permissions without putting keys in arguments or container environment values.

This recipe has been checked on Linux AMD64 with rootless Podman: read-only startup, UID `10001`, secret readability, named-volume initialization and HTTP readiness. Podman's scheduled health checks require a working user systemd manager; the HTTP readiness endpoint can also be checked directly.

To let systemd manage this existing container, stop it before handing it to the supplied user service:

```sh
podman stop --time 60 gravity-studio-rustfs
mkdir -p "$HOME/.config/systemd/user"
cp deploy/rustfs/gravity-studio-rustfs.service "$HOME/.config/systemd/user/"
systemctl --user daemon-reload
systemctl --user enable --now gravity-studio-rustfs.service
systemctl --user status gravity-studio-rustfs.service
```

The unit expects `/usr/bin/podman`; adjust it if your installation differs. Use the [existing user-service instructions](../systemd/README.md#start-after-boot) to enable startup before login. Keep the same volume and secrets when replacing the container for an upgrade.

## Give Studio its own access key

Open `http://127.0.0.1:9001` locally. For a remote server, forward its console with `ssh -L 9001:127.0.0.1:9001 user@server`; the console stays private.

1. Sign in using the administration pair and create the private `gravity-studio` bucket.
2. Add `application-policy.json` as a named IAM policy. It permits object access only below `media-v1/` in that bucket, plus bucket inspection.
3. Create a dedicated `gravity-studio` IAM user, attach that policy, and generate a service access key for the user.
4. Save that application's key pair in Studio's private `.env`, following [storage configuration](../../docs/storage.md#configuration). Keep the administration pair for maintenance.

This is an identity policy, not a public bucket policy. If you change the bucket or prefix, update its resource ARNs too. Service access keys inherit their parent's policy; see [RustFS IAM](https://docs.rustfs.com/en/security-compliance/iam).

## Operations

Use `docker compose -f deploy/rustfs/compose.yaml logs --tail 100 rustfs` or `journalctl --user -u gravity-studio-rustfs.service -n 100 --no-pager` for logs. Docker logs are rotated by this recipe; Podman service logs use the host journal's retention policy.

Back up the complete named volume and credential material while Studio and RustFS are stopped. Keep the matching SQLite backup. Do not remove the volume during an application update. This deployment does not expose buckets publicly or configure object expiration.
