# Run Gravity Studio with systemd

This template runs the API and production web application as a **user service** on the GPU host. Install it under the account that owns the repository and data directory. It does not start or modify ComfyUI workers.

## Prepare the application

Use Node.js 24.13 or newer and pnpm 10.32.1. From the repository:

```sh
pnpm install --frozen-lockfile
cp .env.example .env
pnpm build
```

Keep an existing `.env` when updating. Set `GRAVITY_DATA_DIR` to an absolute persistent directory. Both processes bind to loopback by default. For a reverse proxy, set `GRAVITY_ALLOWED_ORIGINS` to the exact browser origin, including its scheme and any nonstandard port. For direct LAN access, also set `GRAVITY_STUDIO_HOST` to the intended interface address. Keep the API and ComfyUI ports private.

The launcher reads the repository's `.env`; an `EnvironmentFile` directive is unnecessary. The runtime CLI does **not** load that file, so give it the same data directory explicitly, for example `pnpm runtime plan --engine podman --data-dir /absolute/path/to/data`.

## Install the user service

```sh
mkdir -p ~/.config/systemd/user
cp deploy/systemd/gravity-studio.service ~/.config/systemd/user/
```

Edit the copied unit before starting it:

- Replace every `/absolute/path` placeholder with the actual repository and Node installation paths. `command -v node` identifies the executable used by your current shell.
- Set `PATH` to include that Node installation and any GPU inventory utilities, such as `amd-smi`. systemd does not run your interactive shell or initialize its version manager.
- Keep the full repository, installed dependencies and production build available. The launcher does not use Next.js's standalone bundle.

If paths contain spaces, quote the complete `WorkingDirectory` value and each path argument in `ExecStart`. Then load and start the service:

```sh
systemctl --user daemon-reload
systemctl --user enable --now gravity-studio.service
systemctl --user status gravity-studio.service
journalctl --user -u gravity-studio.service -n 50 --no-pager
curl --fail http://127.0.0.1:4321/api/health
```

Adjust the health-check URL if you changed the web address or port. Open the studio and create its owner using `setup.key` in the configured data directory.

## Start after boot

For the user service to run before login and remain available after logout, the host administrator must explicitly enable lingering for the account that owns this installation:

```sh
sudo loginctl enable-linger "$(id -un)"
loginctl show-user "$(id -un)" -p Linger
```

Run those commands from that account. This changes the lifetime of its user service manager, including other enabled user services. ComfyUI worker persistence must be configured separately for the installed container engine; this template does not change existing container restart policies.

## Updates and logs

Stop the service before replacing its build, dependencies or database. Back up the data directory while stopped, install dependencies with the frozen lockfile, rebuild, and start the service again. Changes to the unit require `systemctl --user daemon-reload`; changes to `.env` require a service restart.

```sh
systemctl --user stop gravity-studio.service
# Update the source, back up data, install dependencies and rebuild here.
systemctl --user start gravity-studio.service
journalctl --user -u gravity-studio.service -f
```

The service gives the application 45 seconds to stop, then systemd terminates remaining processes in its control group. GPU detection needs access to host sysfs and the relevant utilities; additional service sandboxing must preserve that visibility.
