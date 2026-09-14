# shellcheck shell=bash
#
# Finds a JDK. Cordova's Android platform needs Java 17 or newer; this machine has a Homebrew JDK, an
# Android Studio JBR and possibly a system one, and `java` is not necessarily on PATH at all — which is
# exactly the case here, so guessing "just run java" would fail on the very machine this was written on.
#
# Sets `JAVA_HOME`. Sourced by the other scripts.

resolve_java_home() {
  if [[ -n "${JAVA_HOME:-}" && -x "$JAVA_HOME/bin/java" ]]; then
    return 0
  fi
  local candidates=(
    "/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home"
    "/opt/homebrew/opt/openjdk@21"
    "/opt/homebrew/opt/openjdk"
    "/usr/local/opt/openjdk@21"
    "/Applications/Android Studio.app/Contents/jbr/Contents/Home"
    "/Library/Java/JavaVirtualMachines/temurin-21.jdk/Contents/Home"
  )
  local candidate
  for candidate in "${candidates[@]}"; do
    if [[ -x "$candidate/bin/java" ]]; then
      export JAVA_HOME="$candidate"
      return 0
    fi
  done
  # Last resort: whatever `java` resolves to, if anything.
  if command -v java >/dev/null 2>&1; then
    export JAVA_HOME="$(cd "$(dirname "$(command -v java)")/.." && pwd)"
    return 0
  fi
  echo "error: no JDK found. Cordova's Android build needs Java 17+." >&2
  echo "       Install one (brew install openjdk@21) or set JAVA_HOME." >&2
  return 1
}
