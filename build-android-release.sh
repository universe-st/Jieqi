#!/usr/bin/env bash
#
# Builds a **signed** release APK of 揭棋.
#
#   ./build-android-release.sh              # full build, signs with the committed keystore
#   ./build-android-release.sh --skip-web   # reuse the existing dist/
#   ./build-android-release.sh --debug      # unsigned debug APK, for a quick device check
#
# What it does, in order:
#   1. finds a JDK and the Android SDK (both are easy to have installed and still not on PATH);
#   2. builds the web bundle with Vite;
#   3. creates the Cordova project on first run, then refreshes its `www/` from `dist/`;
#   4. generates the release keystore if it is missing;
#   5. runs `cordova build android --release` with the signing parameters;
#   6. verifies the signature with `apksigner` and copies the APK to `release/`.
#
# Credentials come from the environment when set, otherwise from the defaults below. See
# `scripts/gen-keystore.sh` for why the keystore is committed, and why you should replace it before
# publishing anything for real.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

# shellcheck source=./scripts/java-home.sh
source "$ROOT/scripts/java-home.sh"

APP_ID="${JIEQI_APP_ID:-com.jieqi.game}"
APP_NAME="${JIEQI_APP_NAME:-JieQi}"
DISPLAY_NAME="${JIEQI_DISPLAY_NAME:-揭棋}"
CORDOVA_DIR="$ROOT/cordova"
KEYSTORE="${JIEQI_KEYSTORE:-$CORDOVA_DIR/keystore/jieqi-release.keystore}"
KEY_ALIAS="${JIEQI_KEY_ALIAS:-jieqi}"
STOREPASS="${JIEQI_KEYSTORE_PASSWORD:-jieqi-release}"
KEYPASS="${JIEQI_KEY_PASSWORD:-$STOREPASS}"
VERSION_NAME="${JIEQI_VERSION_NAME:-$(node -p "require('./package.json').version" 2>/dev/null || echo 1.0.0)}"
VERSION_CODE="${JIEQI_VERSION_CODE:-1}"
OUT_DIR="$ROOT/release"

SKIP_WEB=0
DEBUG_BUILD=0
for arg in "$@"; do
  case "$arg" in
    --skip-web) SKIP_WEB=1 ;;
    --debug) DEBUG_BUILD=1 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

step() { printf '\n\033[1;33m==> %s\033[0m\n' "$1"; }
fail() { printf '\033[1;31merror: %s\033[0m\n' "$1" >&2; exit 1; }

# ---------------------------------------------------------------------------------------------
# 1. Toolchain
# ---------------------------------------------------------------------------------------------
step "Locating the toolchain"
resolve_java_home
echo "  JAVA_HOME    = $JAVA_HOME"
echo "  JDK          = $("$JAVA_HOME/bin/java" -version 2>&1 | head -1)"

if [[ -z "${ANDROID_HOME:-}" && -z "${ANDROID_SDK_ROOT:-}" ]]; then
  for candidate in "$HOME/Library/Android/sdk" "$HOME/Android/Sdk" "/usr/local/lib/android/sdk"; do
    if [[ -d "$candidate" ]]; then export ANDROID_HOME="$candidate"; break; fi
  done
fi
export ANDROID_HOME="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}"
[[ -n "$ANDROID_HOME" && -d "$ANDROID_HOME" ]] || fail "Android SDK not found. Set ANDROID_HOME (or install the SDK)."
export ANDROID_SDK_ROOT="$ANDROID_HOME"
echo "  ANDROID_HOME = $ANDROID_HOME"

if ! command -v pnpm >/dev/null 2>&1; then fail "pnpm is required (packageManager: pnpm@10)."; fi
CORDOVA="$ROOT/node_modules/.bin/cordova"

# ---------------------------------------------------------------------------------------------
# 2. Web bundle
# ---------------------------------------------------------------------------------------------
if [[ "$SKIP_WEB" -eq 0 ]]; then
  step "Installing dependencies"
  pnpm install --frozen-lockfile=false
  step "Building the web bundle"
  pnpm run build
else
  step "Reusing the existing dist/"
fi
[[ -f "$ROOT/dist/index.html" ]] || fail "dist/index.html is missing — run without --skip-web."

# ---------------------------------------------------------------------------------------------
# 3. Cordova project
# ---------------------------------------------------------------------------------------------
if [[ ! -d "$CORDOVA_DIR" ]]; then
  step "Creating the Cordova project"
  [[ -x "$CORDOVA" ]] || fail "cordova is not installed. Run: pnpm install"
  "$CORDOVA" create "$CORDOVA_DIR" "$APP_ID" "$APP_NAME"
fi
[[ -x "$CORDOVA" ]] || fail "cordova is not installed. Run: pnpm install"

step "Drawing the launcher icons"
if command -v python3 >/dev/null 2>&1 && python3 -c 'import PIL' >/dev/null 2>&1; then
  python3 "$ROOT/scripts/build-icons.py"
else
  # The generated PNGs are committed, so a machine without Python/Pillow still builds — it just
  # cannot redraw them.
  echo "  python3 + Pillow not available; using the committed icons in cordova/res/icon/android"
fi

step "Refreshing cordova/www from dist/"
rm -rf "$CORDOVA_DIR/www"
mkdir -p "$CORDOVA_DIR/www"
cp -R "$ROOT/dist/." "$CORDOVA_DIR/www/"

# config.xml is the one project file this repository owns; `cordova create` only ever writes it once.
#
# This heredoc is **unquoted** on purpose — `$APP_ID`, `$VERSION_NAME` and the rest have to expand into
# it — which means every backtick inside the XML must be escaped. Unescaped, the shell runs the text
# between them as a command. That is not hypothetical: the comments below used to carry three of them,
# so every release printed "res/values/colors.xml: No such file or directory" and shipped a config.xml
# with those words silently deleted from its own documentation.
cat > "$CORDOVA_DIR/config.xml" <<XML
<?xml version='1.0' encoding='utf-8'?>
<widget id="$APP_ID" version="$VERSION_NAME" android-versionCode="$VERSION_CODE"
        xmlns="http://www.w3.org/ns/widgets"
        xmlns:cdv="http://cordova.apache.org/ns/1.0">
    <name>$DISPLAY_NAME</name>
    <description>揭棋 — 与 AI 对战的中国象棋变种，暗子随机、翻开方见真章。</description>
    <author email="dev@example.com" href="https://example.com">JieQi</author>
    <content src="index.html" />
    <access origin="*" />
    <allow-intent href="http://*/*" />
    <allow-intent href="https://*/*" />
    <preference name="Orientation" value="portrait" />
    <preference name="Fullscreen" value="true" />
    <preference name="AndroidLaunchMode" value="singleTop" />
    <preference name="SplashMaintainAspectRatio" value="true" />
    <!--
      Android's own colour literal (#AARRGGBB), NOT the 0xAARRGGBB spelling the Cordova docs use:
      cordova-android copies this preference straight into \`res/values/colors.xml\`, and AAPT2 rejects
      the Java-style form with "Invalid <color> for given resource value".
    -->
    <preference name="BackgroundColor" value="#ff1b1210" />
    <preference name="android-minSdkVersion" value="24" />
    <preference name="android-targetSdkVersion" value="35" />
    <preference name="AndroidInsecureFileModeEnabled" value="false" />
    <platform name="android">
        <preference name="android-minSdkVersion" value="24" />
        <preference name="android-targetSdkVersion" value="35" />
        <!--
          Two icons per density. \`src\` is the composed tile used by Android 7 and older; the
          \`background\`/\`foreground\` pair feeds the adaptive icon Android 8+ masks into whatever shape
          the launcher uses. Both are drawn by scripts/build-icons.py — the app ships no art files.

          The outer 108dp canvas is not all visible: Android only guarantees the inner 72dp, which is
          why the foreground keeps the bead at 55% of the canvas.
        -->
        <icon density="ldpi" src="res/icon/android/legacy-ldpi.png" />
        <icon density="mdpi" src="res/icon/android/legacy-mdpi.png" background="res/icon/android/background-mdpi.png" foreground="res/icon/android/foreground-mdpi.png" />
        <icon density="hdpi" src="res/icon/android/legacy-hdpi.png" background="res/icon/android/background-hdpi.png" foreground="res/icon/android/foreground-hdpi.png" />
        <icon density="xhdpi" src="res/icon/android/legacy-xhdpi.png" background="res/icon/android/background-xhdpi.png" foreground="res/icon/android/foreground-xhdpi.png" />
        <icon density="xxhdpi" src="res/icon/android/legacy-xxhdpi.png" background="res/icon/android/background-xxhdpi.png" foreground="res/icon/android/foreground-xxhdpi.png" />
        <icon density="xxxhdpi" src="res/icon/android/legacy-xxxhdpi.png" background="res/icon/android/background-xxxhdpi.png" foreground="res/icon/android/foreground-xxxhdpi.png" />
    </platform>
</widget>
XML

step "Ensuring the Android platform is present"
if [[ ! -d "$CORDOVA_DIR/platforms/android" ]]; then
  ( cd "$CORDOVA_DIR" && "$CORDOVA" platform add android )
else
  echo "  already added"
fi

# ---------------------------------------------------------------------------------------------
# 4. Signing material
# ---------------------------------------------------------------------------------------------
BUILD_ARGS=(android)
if [[ "$DEBUG_BUILD" -eq 1 ]]; then
  step "Building an unsigned DEBUG APK"
  BUILD_ARGS+=(--debug)
  ( cd "$CORDOVA_DIR" && "$CORDOVA" build "${BUILD_ARGS[@]}" )
  APK="$(find "$CORDOVA_DIR/platforms/android/app/build/outputs/apk/debug" -name '*.apk' | head -1)"
  [[ -n "$APK" ]] || fail "no debug APK produced"
  mkdir -p "$OUT_DIR"
  cp "$APK" "$OUT_DIR/jieqi-debug.apk"
  step "Done"
  echo "  $OUT_DIR/jieqi-debug.apk"
  exit 0
fi

step "Ensuring the release keystore"
"$ROOT/scripts/gen-keystore.sh" "$KEYSTORE"

# Android refuses an APK whose versionCode is *lower* than the installed build
# (INSTALL_FAILED_VERSION_DOWNGRADE), and nothing here can read what is on the phone, so the code is
# only ever what the caller passed in — which means the default 1 is right exactly once. Say so rather
# than shipping a downgrade that looks like a successful build.
if [[ -z "${JIEQI_VERSION_CODE:-}" ]]; then
  echo "  note: versionCode is the default 1 — pass JIEQI_VERSION_CODE=<n> to replace an installed build"
fi
echo "  versionName  = $VERSION_NAME"
echo "  versionCode  = $VERSION_CODE"

step "Building the signed release APK"
( cd "$CORDOVA_DIR" && "$CORDOVA" build android --release -- \
    --keystore="$KEYSTORE" \
    --storePassword="$STOREPASS" \
    --alias="$KEY_ALIAS" \
    --password="$KEYPASS" \
    --packageType=apk )

APK="$(find "$CORDOVA_DIR/platforms/android/app/build/outputs/apk/release" -name '*.apk' | head -1)"
[[ -n "$APK" ]] || fail "no release APK produced"

# ---------------------------------------------------------------------------------------------
# 5. Verify the signature and stage the artefact
# ---------------------------------------------------------------------------------------------
step "Verifying the signature"
APKSIGNER="$(find "$ANDROID_HOME/build-tools" -name apksigner -type f 2>/dev/null | sort | tail -1)"
if [[ -n "$APKSIGNER" ]]; then
  "$APKSIGNER" verify --print-certs "$APK" | sed 's/^/  /'
else
  echo "  apksigner not found in $ANDROID_HOME/build-tools — skipping verification"
fi

mkdir -p "$OUT_DIR"
TARGET="$OUT_DIR/jieqi-$VERSION_NAME-release.apk"
cp "$APK" "$TARGET"
SIZE="$(du -h "$TARGET" | cut -f1)"

step "Done"
echo "  signed release APK: $TARGET  ($SIZE)"
echo "  install with:       adb install -r \"$TARGET\""
