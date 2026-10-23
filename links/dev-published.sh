#!/bin/sh
# Revert a `pnpm dev:octane` install back to the lockfile's published packages.
# pnpm considers link: installs version-satisfied and will not restore them on
# its own, so fall back to wiping generated node_modules when links remain.
set -e
cd "$(dirname "$0")/.."
pnpm install --frozen-lockfile
CHECKOUT="$(realpath links/octane-xplat 2>/dev/null || echo __nolink__)"
if find node_modules apps packages -type l -path '*/node_modules/@octane-xplat/*' 2>/dev/null \
	| while read -r link; do realpath "$link"; done | grep -q "^$CHECKOUT"; then
	echo "[dev:published] link: installs still present — wiping node_modules"
	rm -rf node_modules apps/*/node_modules packages/*/node_modules
	pnpm install --frozen-lockfile
fi
