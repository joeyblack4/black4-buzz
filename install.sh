#!/bin/sh
# One command to put Black 4 in Buzz on a Mac.
#
# It installs the sign-in bridge the plugin starts (mcp-remote in front of the
# Black 4 MCP), then opens Buzz's own install review for the plugin. Buzz shows
# what the plugin may do, and nothing is installed until you choose Install.
# Run it again any time; it only repairs the bridge.
set -eu

HERE="$(cd "$(dirname "$0")" 2>/dev/null && pwd || pwd)"
BRIDGE_HOME="${BLACK4_MCP_BRIDGE_HOME:-$HOME/.black4/mcp-bridge}"
BIN="$HOME/.local/bin"
REPOSITORY="${BLACK4_BUZZ_REPOSITORY:-joeyblack4/black4-buzz}"
REF="${BLACK4_BUZZ_REF:-stable}"

if ! command -v node >/dev/null 2>&1; then
  echo "Node 22.12 or newer is required: https://nodejs.org" >&2
  exit 1
fi
if ! node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=12)?0:1)'; then
  echo "Node $(node -v) is too old; Black 4 needs 22.12 or newer." >&2
  exit 1
fi

mkdir -p "$BRIDGE_HOME" "$BIN"
npm install --prefix "$BRIDGE_HOME" --save-exact --no-fund --no-audit mcp-remote@0.15.2 >/dev/null
command -v node > "$BRIDGE_HOME/node-path"
if [ -f "$HERE/bridge/black4-mcp-bridge" ]; then
  install -m 755 "$HERE/bridge/black4-mcp-bridge" "$BIN/black4-mcp-bridge"
else
  # Run straight from the web, without a checkout: fetch the bridge it needs.
  curl -fsSL "https://raw.githubusercontent.com/$REPOSITORY/$REF/bridge/black4-mcp-bridge" -o "$BIN/black4-mcp-bridge.tmp"
  chmod 755 "$BIN/black4-mcp-bridge.tmp"
  mv "$BIN/black4-mcp-bridge.tmp" "$BIN/black4-mcp-bridge"
fi
echo "Sign-in bridge installed at $BIN/black4-mcp-bridge"

for arg in "$@"; do
  case "$arg" in
    --bridge-only) exit 0 ;;
  esac
done

LINK="buzz://plugin-install?repository=$(printf %s "$REPOSITORY" | sed 's|/|%2F|g')&ref=$REF&path=plugins%2Fblack4"
echo "Opening Buzz to review and install the plugin:"
echo "  $LINK"
open "$LINK" 2>/dev/null || echo "Open that link yourself once Buzz is installed."
echo "After you choose Install, turn the plugin on and finish the Black 4 sign-in in your browser."
