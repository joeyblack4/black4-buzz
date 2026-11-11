#!/bin/sh
# One command to put Black 4 in Buzz on a Mac.
#
# It installs the sign-in bridge the plugin starts (mcp-remote in front of the
# Black 4 MCP), then opens Buzz's own install review for the plugin. Buzz shows
# what the plugin may do, and nothing is installed until you choose Install.
# Run it again any time; it only repairs the bridge.
set -eu

HERE="$(cd "$(dirname "$0")" && pwd)"
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
install -m 755 "$HERE/bridge/black4-mcp-bridge" "$BIN/black4-mcp-bridge"
echo "Sign-in bridge installed at $BIN/black4-mcp-bridge"

PRIVATE=0
for arg in "$@"; do
  case "$arg" in
    --bridge-only) exit 0 ;;
    --private) PRIVATE=1 ;;
  esac
done

# While the repository is private, Buzz reads it over SSH with a key from your
# SSH agent: it never uses your Git sign-in, credential helpers or prompts.
# --private writes the Buzz rule that says so, unless you already have rules.
if [ "$PRIVATE" = 1 ]; then
  OWNER="${REPOSITORY%%/*}"
  DATA="${BUZZODZ_HOME:-$HOME/Library/Application Support/xyz.block.buzz.desktop}"
  ACCESS="$DATA/repository-access.json"
  if [ -e "$ACCESS" ]; then
    echo "Kept your existing $ACCESS. It needs a github.com rule for /$OWNER/ with sshUser git."
  else
    mkdir -p "$DATA"
    printf '{\n  "version": 1,\n  "rules": [\n    { "host": "github.com", "pathPrefix": "/%s/", "sshUser": "git" }\n  ]\n}\n' "$OWNER" > "$ACCESS.tmp"
    mv "$ACCESS.tmp" "$ACCESS"
    echo "Wrote $ACCESS so Buzz reads github.com/$OWNER over SSH."
  fi
  if ! ssh-add -l >/dev/null 2>&1; then
    echo "Your SSH agent holds no key. Add the key GitHub knows (ssh-add --apple-use-keychain ~/.ssh/id_ed25519), then run this again." >&2
    exit 1
  fi
fi

LINK="buzz://plugin-install?repository=$(printf %s "$REPOSITORY" | sed 's|/|%2F|g')&ref=$REF&path=plugins%2Fblack4"
echo "Opening Buzz to review and install the plugin:"
echo "  $LINK"
open "$LINK" 2>/dev/null || echo "Open that link yourself once Buzz is installed."
echo "After you choose Install, turn the plugin on and finish the Black 4 sign-in in your browser."
