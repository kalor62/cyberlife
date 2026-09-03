#!/bin/bash
# Build Cyber Life. On macOS this also compiles the Swift dictation helper and
# produces a signed .app; on Linux it produces a plain binary.
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$PROJECT_DIR"

# wails v2.11 generates bindings with an x/tools that cannot read export data
# from Go >= 1.27 ("internal error: package "os" without types"), and the
# build then stops with the OLD binary still in build/bin. Pin the toolchain
# the project is tested with; `go` downloads it on first use.
export GOTOOLCHAIN="${GOTOOLCHAIN:-go1.25.3}"

WAILS="${WAILS:-$HOME/go/bin/wails}"
if [ ! -x "$WAILS" ]; then
  WAILS="$(command -v wails || true)"
fi
if [ -z "$WAILS" ]; then
  echo "wails not found. Install the toolchain with:" >&2
  echo "  go install github.com/wailsapp/wails/v2/cmd/wails@latest" >&2
  echo "then re-run, or point WAILS= at the binary." >&2
  exit 1
fi

# Official addons live in addons/ but the app loads them from
# ~/.cyberlife/addons, so a plain "git pull" would leave them stale — or
# missing entirely on a fresh clone. Install them on every build, exactly like
# the documented dev loop does by hand. A folder here is a copy of the repo,
# not a place to keep local edits.
install_addons() {
  local target="${CYBERLIFE_HOME:-$HOME/.cyberlife}/addons"
  mkdir -p "$target"
  for id in "${SHIPPED_ADDONS[@]}"; do
    [ -d "addons/$id" ] || continue
    rm -rf "${target:?}/$id"
    cp -r "addons/$id" "$target/"
    echo "  addon: $id → $target/$id"
  done
}

SHIPPED_ADDONS=(terminarz cyber-bot)

case "$(uname -s)" in
  Darwin)
    APP="build/bin/CyberLife.app"

    # Recompile the dictation helper so engine changes in voice_input.swift take
    # effect (Go only lazily compiles it when the binary is missing).
    if [ -f scripts/voice_input.swift ]; then
      swiftc -O -o scripts/voice_input scripts/voice_input.swift \
        -framework Speech -framework AVFoundation || echo "WARN: voice_input compile failed"
    fi

    "$WAILS" build -devtools "$@"

    # Wails generates its own icon; install ours and invalidate the icon cache
    if [ -f build/appicon.icns ]; then
      cp build/appicon.icns "$APP/Contents/Resources/iconfile.icns"
      touch "$APP"
    fi

    # Re-sign with entitlements so macOS remembers microphone permission across rebuilds
    codesign --force --deep --sign - \
      --entitlements build/darwin/entitlements.plist "$APP"

    install_addons
    echo "✓ Build complete: $PROJECT_DIR/$APP"
    echo "  Run: open $APP"
    ;;

  Linux)
    # No Swift helper (dictation needs Speech.framework) and no code signing.
    # iTerm2 is absent too, which the app already treats as normal — tmux is
    # the session backend on both platforms.

    # Wails compiles against webkit2gtk-4.0 by default, but newer distros
    # (Ubuntu 24.04+) only ship 4.1 — build with the matching tag.
    TAGS=()
    if ! pkg-config --exists webkit2gtk-4.0 2>/dev/null \
        && pkg-config --exists webkit2gtk-4.1 2>/dev/null; then
      TAGS=(-tags webkit2_41)
    fi

    "$WAILS" build -devtools "${TAGS[@]}" "$@"
    install_addons
    echo "✓ Build complete: $PROJECT_DIR/build/bin/CyberLife"
    echo "  Run: ./build/bin/CyberLife"
    ;;

  *)
    echo "Unsupported platform: $(uname -s) — macOS and Linux are supported." >&2
    exit 1
    ;;
esac
