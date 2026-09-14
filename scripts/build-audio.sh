#!/usr/bin/env bash
#
# Builds `public/audio/` — the soundtrack and the sound effects the game plays.
#
# Two sources:
#
#   * the background music, downloaded from the URL below and re-encoded to MP3;
#   * the sound effects, picked out of the local GameBurp "2000 Game Sound FX" library and re-encoded
#     to MP3 (the library ships WAV and OGG; WAV is the lossless one, so that is the one to transcode
#     from — going OGG to MP3 would be a generation loss for nothing).
#
# Everything lands as MP3 because that is the one audio format Phaser 4 can rely on in every browser as
# well as in the Android WebView the Cordova build runs in.
#
# The converted files are committed, so a normal checkout does not need this script — it exists so the
# provenance of every sound is readable and so the whole set can be regenerated in one command.
#
#   scripts/build-audio.sh                 # uses the default library path
#   GAMEBURP_DIR=/path/to/fx scripts/build-audio.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$ROOT/public/audio"
SFX_OUT="$OUT/sfx"

MUSIC_URL="${JIEQI_MUSIC_URL:-https://cdn-work.muse.top/work/audio/80b4611bc45147418d85deb0d9db7e88.m4a}"
GAMEBURP_DIR="${GAMEBURP_DIR:-$HOME/音效/GameBurp - 2000 Game Sound FX/GameBurp - 2000 Game Sound FX Collection (WAV)}"
CACHE="$ROOT/.audio-cache"

command -v ffmpeg >/dev/null || { echo "error: ffmpeg is required (brew install ffmpeg)" >&2; exit 1; }

# ---------------------------------------------------------------------------------------------
# The sound design. One line per cue; the middle column is the filename inside the GameBurp library.
#
# Note: `name|cue|source`
# ---------------------------------------------------------------------------------------------
CUES=(
  "ui-click|button press                       |IMPACTS - HITS - (50)/IMPACT Button Press Click 01.wav"
  "pick    |selecting a piece                 |SUCCESS - PICKUPS - (109)/SUCCESS PICKUP Collect Beep Short 01.wav"
  "place   |a piece landing on wood           |EXPLOSIONS - DESTRUCTION - (80)/DESTRUCTION Break Impact Wood 04.wav"
  "reveal  |turning a face-down piece over    |SUCCESS - CHIMES - (55)/SUCCESS CHIME Ascending Sparkle 06.wav"
  "capture |a piece being taken               |EXPLOSIONS - DESTRUCTION - (80)/DESTRUCTION Break Impact Smash Short 01.wav"
  "check   |将军 — the general is attacked    |BONGS - TIMERS - BELLS - (72)/BONG Bell Timer Hit Deep 01.wav"
  "deal    |shuffling and laying out the board|SHAKERS - SHUFFLES - ROLLS - (24)/SHAKER Pieces Shuffle 01.wav"
  "undo    |taking a move back                |SWIPES - SLASHES - WHOOSHES - (58)/SWIPE Slider Zip Movement 01.wav"
  "win     |victory                           |SUCCESS - TUNES - CHEERS - (64)/SUCCESS TUNE Win Complete 05.wav"
  "lose    |defeat                            |NEGATIVE - FAILURE - TENSION - (73)/NEGATIVE Failure Descending Bell Run 01.wav"
  "draw    |a drawn game                      |SUCCESS - CHIMES - (55)/SUCCESS CHIME Bells Sparkle Tune 01.wav"
  # 开始界面 / 定先后. The spin cue is picked to *fit the spin*: the draw turns the piece for
  # SPIN_TOTAL_MS = 2.4 s (src/core/spin.ts) and this rattle runs 2.38 s, so one cue covers the whole
  # turn — the sound ends when the piece does, with nothing looped and nothing cut off.
  "spin    |the 定先后 piece turning          |SLIDERS - DRAG MOVEMENTS - (65)/SLIDER Swipe Drag Movement Heavy Long Rattle 02.wav"
  "land    |the piece settling on its face    |BONGS - TIMERS - BELLS - (72)/BONG Clunk Hit 02.wav"
  "omen    |你执红 / 你执黑 — the verdict      |SUCCESS - CHIMES - (55)/SUCCESS CHIME Mystery Magic Spell Sparkle 04.wav"
)

mkdir -p "$SFX_OUT" "$CACHE"

# ---------------------------------------------------------------------------------------------
# Music
# ---------------------------------------------------------------------------------------------
if [[ ! -f "$CACHE/bgm.m4a" ]]; then
  echo "==> downloading the music"
  curl -fsSL -o "$CACHE/bgm.m4a" "$MUSIC_URL"
fi

echo "==> encoding bgm.mp3"
# 128 kbps stereo is generous for a solo instrumental, and keeps three minutes of it under 3 MB —
# which matters, because this file ships inside the APK.
ffmpeg -y -v error -i "$CACHE/bgm.m4a" -acodec libmp3lame -b:a 128k -ar 44100 -ac 2 "$OUT/bgm.mp3"

# ---------------------------------------------------------------------------------------------
# State music (menu / win / lose)
# ---------------------------------------------------------------------------------------------
# The game switches its looping track by state (see `src/audio/AudioDirector.ts`). Same provenance
# pattern as the game track: download once into the cache, re-encode to MP3. These are compressed
# harder — mono ~48-64 kbps — so each lands around 1 MB; they ship inside the APK and are background
# beds, not something the player leans in to hear.
#
# Format: file|label|cache-key|URL|bitrate
STATE_MUSIC=(
  "bgm-menu|menu|0f340bac68ff4e3b8e8498fae60b7288.m4a|https://cdn-work.muse.top/work/audio/0f340bac68ff4e3b8e8498fae60b7288.m4a|48k"
  "bgm-win|win|1b16a625cdc04691bd8e11c815fe5ea9.mp3|https://cdn-work.muse.top/work/audio/1b16a625cdc04691bd8e11c815fe5ea9.mp3|64k"
  "bgm-lose|lose|242ce2ca9ecc420d8655b3e7e2e6cfaa.mp3|https://cdn-work.muse.top/work/audio/242ce2ca9ecc420d8655b3e7e2e6cfaa.mp3|48k"
)

for entry in "${STATE_MUSIC[@]}"; do
  IFS='|' read -r file label cache_key url bitrate <<< "$entry"
  if [[ ! -f "$CACHE/$cache_key" ]]; then
    echo "==> downloading the $label music"
    curl -fsSL -o "$CACHE/$cache_key" "$url"
  fi
  echo "==> encoding $file.mp3"
  ffmpeg -y -v error -i "$CACHE/$cache_key" -acodec libmp3lame -b:a "$bitrate" -ar 44100 -ac 1 "$OUT/$file.mp3"
done

# ---------------------------------------------------------------------------------------------
# Sound effects
# ---------------------------------------------------------------------------------------------
echo "==> encoding sound effects"
for entry in "${CUES[@]}"; do
  # The table is column-aligned for readability, so every field has to be trimmed before use —
  # otherwise the padding ends up in the filename (`capture .mp3`).
  name="$(printf '%s' "${entry%%|*}" | xargs)"
  rest="${entry#*|}"
  label="$(printf '%s' "${rest%%|*}" | xargs)"
  source="$(printf '%s' "${rest#*|}" | xargs)"
  file="$GAMEBURP_DIR/$source"
  if [[ ! -f "$file" ]]; then
    echo "  MISSING: $file" >&2
    continue
  fi
  ffmpeg -y -v error -i "$file" -acodec libmp3lame -b:a 128k -ar 44100 -ac 2 "$SFX_OUT/$name.mp3"
  printf '  %-8s %s\n' "$name" "$label"
done

echo
echo "==> $OUT"
find "$OUT" -name '*.mp3' -exec du -h {} + | sort -k2
echo "  total: $(du -sh "$OUT" | cut -f1)"
