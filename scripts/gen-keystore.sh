#!/usr/bin/env bash
#
# Creates the Android release keystore this repository signs its APKs with.
#
# The keystore and its password are committed on purpose, so `build-android-release.sh` works on a
# fresh clone with no extra setup. That is fine for a sample/demo build and **wrong for a real
# release**: anyone with the file and the password can publish an update that Android will accept as
# yours. Before shipping to a store, generate your own, keep the keystore out of version control, and
# pass the credentials through the environment.
#
# Usage:  scripts/gen-keystore.sh [output.keystore]
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
KEYSTORE="${1:-$ROOT/cordova/keystore/jieqi-release.keystore}"
ALIAS="${JIEQI_KEY_ALIAS:-jieqi}"
STOREPASS="${JIEQI_KEYSTORE_PASSWORD:-jieqi-release}"
KEYPASS="${JIEQI_KEY_PASSWORD:-$STOREPASS}"
VALIDITY="${JIEQI_KEY_VALIDITY:-10000}"

# keytool ships with the JDK; find one the same way the release script does.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./java-home.sh
source "$SCRIPT_DIR/java-home.sh"
resolve_java_home

if [[ -f "$KEYSTORE" ]]; then
  echo "keystore already exists: $KEYSTORE"
  exit 0
fi

mkdir -p "$(dirname "$KEYSTORE")"
"$JAVA_HOME/bin/keytool" -genkeypair \
  -keystore "$KEYSTORE" \
  -alias "$ALIAS" \
  -keyalg RSA -keysize 2048 -validity "$VALIDITY" \
  -storetype PKCS12 \
  -storepass "$STOREPASS" -keypass "$KEYPASS" \
  -dname "CN=JieQi, OU=Games, O=JieQi, L=Guangzhou, ST=Guangdong, C=CN"

echo "created $KEYSTORE"
echo "  alias:     $ALIAS"
echo "  storepass: $STOREPASS"
"$JAVA_HOME/bin/keytool" -list -v -keystore "$KEYSTORE" -storepass "$STOREPASS" | grep -E "Alias|Valid|SHA256" | head -5
