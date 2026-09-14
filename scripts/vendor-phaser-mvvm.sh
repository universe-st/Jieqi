#!/usr/bin/env bash
#
# Re-vendor the phaser-mvvm packages from a checkout of the framework.
#
# Why vendor instead of `link:`/`file:`? phaser-mvvm 1.0.0 is not published to npm, and this game
# repo has to build on its own (offline, on CI, and inside the Cordova release script) without
# assuming a sibling checkout exists. Vendoring the four packages' *source* — which is what their
# `exports` map already points at (`./src/index.ts`) — keeps the repo self-contained while still
# consuming the framework as real workspace dependencies (`workspace:*`).
#
# Usage:  scripts/vendor-phaser-mvvm.sh [path-to-phaser-mvvm-checkout]
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="${1:-/Users/kuangshensheng/codes/phaser-mvvm}"
DEST="$ROOT/vendor/phaser-mvvm"

if [[ ! -d "$SRC/packages/widgets/src" ]]; then
  echo "error: '$SRC' does not look like a phaser-mvvm checkout (no packages/widgets/src)" >&2
  exit 1
fi

rm -rf "$DEST/packages"
mkdir -p "$DEST/packages"
cp "$SRC/tsconfig.base.json" "$DEST/tsconfig.base.json"
cp "$SRC/LICENSE" "$DEST/LICENSE"

for pkg in core layout phaser widgets; do
  mkdir -p "$DEST/packages/$pkg"
  cp -R "$SRC/packages/$pkg/src" "$DEST/packages/$pkg/src"
  cp "$SRC/packages/$pkg/package.json" "$DEST/packages/$pkg/package.json"
  cat > "$DEST/packages/$pkg/tsconfig.json" <<'JSON'
{
  "extends": "../../tsconfig.base.json",
  "include": ["src"]
}
JSON
done

# The vendored copy ships source only: drop the publish-oriented `files`/`publishConfig` and the
# build/test scripts, so a fresh `pnpm install` does not pull tsup/vitest copies for packages this
# repo never builds separately.
node - "$DEST" <<'NODE'
const { readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const dest = process.argv[2];
for (const pkg of ['core', 'layout', 'phaser', 'widgets']) {
  const file = join(dest, 'packages', pkg, 'package.json');
  const json = JSON.parse(readFileSync(file, 'utf8'));
  json.version = '1.0.0';
  json.private = true;
  delete json.files;
  delete json.publishConfig;
  delete json.devDependencies;
  json.scripts = { typecheck: 'tsc -p tsconfig.json' };
  writeFileSync(file, `${JSON.stringify(json, null, 2)}\n`);
}
NODE

# ---------------------------------------------------------------------------------------------
# Local fixes on top of upstream.
#
# These are bugs this project hit while using the framework, kept as an explicit patch step so that
# re-vendoring never silently drops them. Each one names the symptom it fixes, because a silent
# divergence from upstream is worse than no divergence at all.
# ---------------------------------------------------------------------------------------------
apply_local_fix() {
  local file="$1"
  local python="$2"
  python3 - "$file" <<PY
import sys
path = sys.argv[1]
src = open(path, encoding='utf-8').read()
$python
open(path, 'w', encoding='utf-8').write(src)
PY
}

# Slider: `localXOf` summed the ancestors' `x` but skipped the widget's own, so a slider that is not at
# x=0 inside its parent mapped the pointer by that offset — the volume dialog's sliders (x=44 in their
# row) read 0.20 when you clicked their left edge and 0.75 when you clicked the middle.
apply_local_fix "$DEST/packages/widgets/src/Slider.ts" "
old = '''    let offset = 0;
    let node: Phaser.GameObjects.Container | null = this.parentContainer;
    while (node) {
      offset += node.x;
      node = node.parentContainer;
    }
    return point.x - offset;'''
new = '''    // The widget's own \`x\` is part of the offset: \`applyLocalX\` maps onto \`this.rect\`, whose origin
    // is this widget's top-left corner, so local 0 has to be the left edge — not the parent's.
    let offset = this.x;
    let node: Phaser.GameObjects.Container | null = this.parentContainer;
    while (node) {
      offset += node.x;
      node = node.parentContainer;
    }
    return point.x - offset;'''
if old not in src:
    raise SystemExit('Slider.ts: localXOf body not found — upstream changed, re-check the patch')
src = src.replace(old, new)
"

echo "vendored phaser-mvvm -> $DEST"""
find "$DEST/packages" -name '*.ts' | wc -l | xargs echo "  source files:"
