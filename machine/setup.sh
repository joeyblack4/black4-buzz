#!/bin/sh
# Installs what a Buzz agent needs on a Black 4 machine, under ~/workforce.
# Run from a computer that can reach the machine:
#   ssh <machine> 'MACHINE_NAME=<machine> sh -s' < machine/setup.sh
# MACHINE_NAME is what machine.status reports (default: the host name).
# Safe to run again: it only fetches what is missing. No sudo.
set -eu

NODE_VERSION=24.22.3
NODE_SHA256=ff6e17d4874b76d272212b908cc020d6e815fba5a6c7eaaa06add725840307fd  # node-v24.22.3-darwin-arm64.tar.gz
# The ACP adapters must speak the protocol of the buzz-acp harness, which is
# Buzz 0.5.30's (vendor/buzz-0.5.30). Its initialize offers protocolVersion 2
# with a `clientInfo` field. @agentclientprotocol/sdk 2.0.1 and later reject
# that shape with -32602 (they want `info`), so agents never start. SDK 2.0.0
# and 1.x answer with protocolVersion 1, which buzz-acp accepts. These are the
# newest adapters on such an SDK; each SDK is pinned exactly below. Move these
# only together with the vendored Buzz, and check the initialize handshake.
CLAUDE_ACP_VERSION=0.94.0   # @agentclientprotocol/claude-agent-acp (SDK 2.0.0)
CLAUDE_ACP_SDK=2.0.0
CODEX_ACP_VERSION=2.2.2     # @agentclientprotocol/codex-acp (SDK ^1.5.0)
CODEX_ACP_SDK=1.9.0

ROOT="$HOME/workforce"
VENDOR="$ROOT/vendor"
BIN="$ROOT/bin"
NODE_DIR="$VENDOR/node-v$NODE_VERSION-darwin-arm64"
ACP_DIR="$VENDOR/acp"

[ "$(uname -s)-$(uname -m)" = "Darwin-arm64" ] || { echo "this script is for Apple Silicon Macs" >&2; exit 1; }
mkdir -p "$VENDOR" "$BIN" "$ROOT/logins" "$ROOT/secrets" "$ROOT/run"
chmod 700 "$ROOT/logins" "$ROOT/secrets" "$ROOT/run"

if [ ! -x "$NODE_DIR/bin/node" ]; then
  tmp=$(mktemp -d "$VENDOR/.node.XXXXXX")
  trap 'rm -rf "$tmp"' EXIT
  echo "downloading Node $NODE_VERSION"
  /usr/bin/curl -fsSL -o "$tmp/node.tar.gz" "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-darwin-arm64.tar.gz"
  got=$(/usr/bin/shasum -a 256 "$tmp/node.tar.gz" | cut -d' ' -f1)
  [ "$got" = "$NODE_SHA256" ] || { echo "Node download checksum mismatch: $got" >&2; exit 1; }
  /usr/bin/tar -xzf "$tmp/node.tar.gz" -C "$tmp"
  rm -rf "$NODE_DIR"
  mv "$tmp/node-v$NODE_VERSION-darwin-arm64" "$NODE_DIR"
  rm -rf "$tmp"
  trap - EXIT
fi
for tool in node npm npx; do ln -sfn "$NODE_DIR/bin/$tool" "$BIN/$tool"; done
export PATH="$NODE_DIR/bin:/usr/bin:/bin"

want="@agentclientprotocol/claude-agent-acp@$CLAUDE_ACP_VERSION (sdk $CLAUDE_ACP_SDK) @agentclientprotocol/codex-acp@$CODEX_ACP_VERSION (sdk $CODEX_ACP_SDK)"
have=$(cat "$ACP_DIR/.installed" 2>/dev/null || true)
if [ "$have" != "$want" ]; then
  echo "installing $want"
  rm -rf "$ACP_DIR"
  mkdir -p "$ACP_DIR"
  cat > "$ACP_DIR/package.json" <<JSON
{
  "name": "workforce-acp",
  "private": true,
  "dependencies": {
    "@agentclientprotocol/claude-agent-acp": "$CLAUDE_ACP_VERSION",
    "@agentclientprotocol/codex-acp": "$CODEX_ACP_VERSION"
  },
  "overrides": {
    "@agentclientprotocol/claude-agent-acp": { "@agentclientprotocol/sdk": "$CLAUDE_ACP_SDK" },
    "@agentclientprotocol/codex-acp": { "@agentclientprotocol/sdk": "$CODEX_ACP_SDK" }
  }
}
JSON
  npm install --prefix "$ACP_DIR" --no-fund --no-audit --loglevel=error
  echo "$want" > "$ACP_DIR/.installed"
fi
for tool in claude-agent-acp codex-acp; do ln -sfn "$ACP_DIR/node_modules/.bin/$tool" "$BIN/$tool"; done
# The Claude Code binary bundled with the adapter is what agents run; agentctl
# uses the same one for sign-in and for checking the stored credential.
ln -sfn "$ACP_DIR/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude" "$BIN/claude"

if [ -n "${MACHINE_NAME:-}" ]; then
  printf '{"name": "%s"}\n' "$MACHINE_NAME" > "$ROOT/machine.json"
fi

echo "node $("$BIN/node" --version), $want"
echo "setup done"
