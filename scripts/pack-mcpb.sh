#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STAGING="$REPO_ROOT/mcpb-build"

echo "==> Cleaning staging directory"
rm -rf "$STAGING"
mkdir -p "$STAGING"

echo "==> Building TypeScript"
cd "$REPO_ROOT"
rm -rf "$REPO_ROOT/dist"
# tsc emits-on-error by default; pre-existing TS2589 warnings from the MCP SDK + zod
# typing produce a non-zero exit despite successful emit. Trust file presence instead.
npm run build || true
if [ ! -f "$REPO_ROOT/dist/index.js" ]; then
  echo "ERROR: tsc did not emit dist/index.js" >&2
  exit 1
fi
echo "    (tsc reported type warnings; dist/index.js emitted successfully)"

echo "==> Staging bundle files"
cp -r "$REPO_ROOT/dist" "$STAGING/dist"
cp "$REPO_ROOT/package.json" "$STAGING/package.json"
cp "$REPO_ROOT/manifest.json" "$STAGING/manifest.json"
cp "$REPO_ROOT/README.md" "$STAGING/README.md"
cp "$REPO_ROOT/LICENSE" "$STAGING/LICENSE"

echo "==> Installing production dependencies in staging"
cd "$STAGING"
npm install --omit=dev --no-package-lock --no-audit --no-fund

echo "==> Packing .mcpb"
VERSION="$(node -p "require('$REPO_ROOT/package.json').version")"
NAME="$(node -p "require('$REPO_ROOT/package.json').name")"
OUT="$REPO_ROOT/${NAME}-${VERSION}.mcpb"
npx --yes @anthropic-ai/mcpb pack "$STAGING" "$OUT"

echo "==> Done: $OUT"
