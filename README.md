# Gravity Studio

A self-hosted image studio for your own GPU server. Gravity keeps generation jobs, model recipes, and saved images together, with a shared ComfyUI backend and hardware-aware scheduling.

This repository is under active development. Installation instructions and supported runtime profiles are added alongside their implementations.

## Development

Use Node.js 24.13 or newer and pnpm 10.

```sh
pnpm install
pnpm dev
```

Local configuration and generated media live in `storage/`, outside version control. Model weights are supplied separately.

## Contributions

Keep changes focused and independently reviewable. Include tests for behavior changes and keep model definitions independent of a particular host or GPU identifier.
