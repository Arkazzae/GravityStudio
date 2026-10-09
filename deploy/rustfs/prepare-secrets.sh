#!/bin/sh
set -eu

if [ "$#" -ne 1 ]; then
  printf 'Usage: sh deploy/rustfs/prepare-secrets.sh /absolute/private/secrets-directory\n' >&2
  exit 1
fi
case "$1" in
  /*) rustfs_secrets_dir="$1" ;;
  *) printf 'Choose an absolute secrets directory outside the source checkout.\n' >&2; exit 1 ;;
esac
if [ -L "$rustfs_secrets_dir" ]; then
  printf 'The secrets directory must not be a symbolic link.\n' >&2
  exit 1
fi
for rustfs_name in access_key secret_key; do
  if [ -e "$rustfs_secrets_dir/$rustfs_name" ] || [ -L "$rustfs_secrets_dir/$rustfs_name" ]; then
    printf 'Credentials already exist; refusing to replace them.\n' >&2
    exit 1
  fi
done

command -v openssl >/dev/null
umask 077
mkdir -p "$rustfs_secrets_dir"
chmod 700 "$rustfs_secrets_dir"
rustfs_access_key=$(openssl rand -hex 12)
rustfs_secret_key=$(openssl rand -hex 32)
(
  set -C
  printf '%s\n' "$rustfs_access_key" | tr '[:lower:]' '[:upper:]' > "$rustfs_secrets_dir/access_key"
  printf '%s\n' "$rustfs_secret_key" > "$rustfs_secrets_dir/secret_key"
)
# Compose bind-mounts file secrets without remapping their host UID. The private
# 0700 parent protects these readable files while container UID 10001 can use them.
chmod 444 "$rustfs_secrets_dir/access_key" "$rustfs_secrets_dir/secret_key"
printf 'Created private RustFS credentials. Existing credentials were not changed.\n'
