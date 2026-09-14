#!/usr/bin/env bash
#
# Builds `public/fonts/LXGWWenKai-Regular.woff2` — the one font the whole game is set in.
#
# Source: LXGW WenKai (霞鹜文楷) v1.522, a 楷体-flavoured screen font by LXGW, licensed under the SIL Open
# Font License 1.1 (the licence travels with the font, see `public/fonts/OFL.txt`). The upstream files are
# 25 MB TrueType faces; the WebView has to parse whatever we ship *at every cold start*, so they are
# transcoded to WOFF2, which lands at about 7.9 MB and decompresses to the same outlines.
#
# Why WOFF2 and not a subset: a subset would be ~75 KB, but it would silently fall back to a system serif
# for any glyph somebody adds later — and this game's text is all Chinese, so a missing glyph is not a
# cosmetic problem, it is a different typeface appearing mid-sentence. Keeping the full character set
# means "the game is set in 霞鹜文楷" stays true whatever the strings become.
#
# Only the Regular weight is produced. Nothing in the game — nor in phaser-mvvm's theme, which is the only
# thing that styles HUD text — ever asks for a bold or italic face, so a second 8 MB download would buy
# nothing.
#
# The converted file is committed, so a normal checkout does not need this script; it exists so the
# provenance of the font is readable and so it can be regenerated in one command.
#
#   scripts/build-font.sh
#   JIEQI_FONT_SRC=/path/to/lxgw-wenkai-v1.522 scripts/build-font.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="${JIEQI_FONT_SRC:-${1:-$HOME/字体/lxgw-wenkai-v1.522}}"
OUT_DIR="$ROOT/public/fonts"
FACE="LXGWWenKai-Regular"

if ! command -v pyftsubset >/dev/null 2>&1; then
  echo "error: pyftsubset is required (pip install fonttools brotli)" >&2
  exit 1
fi
[[ -f "$SRC/$FACE.ttf" ]] || { echo "error: $SRC/$FACE.ttf not found — set JIEQI_FONT_SRC" >&2; exit 1; }

mkdir -p "$OUT_DIR"
cp -f "$SRC/OFL.txt" "$OUT_DIR/OFL.txt"

echo "==> $FACE.ttf → $FACE.woff2"
# `--unicodes='*'` keeps every glyph (see the note above); `--no-hinting` drops the TrueType hinting
# programs, which the Android WebView ignores anyway on a 2–3× display and which cost real bytes.
pyftsubset "$SRC/$FACE.ttf" \
  --unicodes='*' \
  --layout-features='*' \
  --no-hinting \
  --flavor=woff2 \
  --output-file="$OUT_DIR/$FACE.woff2"

echo "==> done"
ls -lh "$OUT_DIR/$FACE.woff2" | sed 's/^/    /'
echo "    (the game loads it at boot and shows the progress on the loading page)"
