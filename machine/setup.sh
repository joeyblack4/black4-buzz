#!/bin/sh
# Installs what a Buzz agent needs on a Black 4 machine, under ~/workforce.
# Run from a checkout, on a computer that can reach the machine:
#   machine/deploy.sh <machine> [name]
# That copies agentctl and the Black 4 connector next to this script and runs
# it there. Piped on its own (ssh <machine> 'sh -s' < machine/setup.sh) it
# installs Node and the ACP adapters only.
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
# codex-acp runs the Codex CLI's app-server; it depends on @openai/codex
# ^0.160.1, held here to the exact build it was tested with. agentctl runs the
# same CLI for sign-in (codex login --device-auth) and the sign-in check.
CODEX_CLI_VERSION=0.160.1   # @openai/codex
# Grok Build is xAI's own CLI and ACP agent (grok agent stdio). xAI publishes
# no checksums, so this is the SHA-256 of the gzip from x.ai/cli that was
# checked against buzz-acp (Apple-signed, team 5Y6N3AJ54S).
GROK_VERSION=1.0.70
GROK_SHA256=9c83a2b8b28064574b65e1fa50e8342dd5d797d81c5c724c1d60bb0ad35e3199  # grok-1.0.70-macos-aarch64.gz

# BLACK4_WORKFORCE_ROOT puts a second runner beside the real one (for example
# $HOME/workforce-dev), with its own agents, sign-ins and cron lines.
ROOT="${BLACK4_WORKFORCE_ROOT:-$HOME/workforce}"
case "$ROOT" in /*) ;; *) ROOT="$HOME/$ROOT" ;; esac
# Files shipped with this script by deploy.sh (absent when piped to sh -s).
case "$0" in
  */setup.sh) SRC=$(cd "$(dirname "$0")/.." && pwd) ;;
  *) SRC=/nonexistent ;;
esac
VENDOR="$ROOT/vendor"
BIN="$ROOT/bin"
NODE_DIR="$VENDOR/node-v$NODE_VERSION-darwin-arm64"
ACP_DIR="$VENDOR/acp"

[ "$(uname -s)-$(uname -m)" = "Darwin-arm64" ] || { echo "this script is for Apple Silicon Macs" >&2; exit 1; }
mkdir -p "$VENDOR" "$BIN" "$ROOT/logins" "$ROOT/secrets" "$ROOT/run" "$ROOT/homes"
chmod 700 "$ROOT/logins" "$ROOT/secrets" "$ROOT/run" "$ROOT/homes"

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

want="@agentclientprotocol/claude-agent-acp@$CLAUDE_ACP_VERSION (sdk $CLAUDE_ACP_SDK) @agentclientprotocol/codex-acp@$CODEX_ACP_VERSION (sdk $CODEX_ACP_SDK, codex $CODEX_CLI_VERSION)"
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
    "@agentclientprotocol/codex-acp": { "@agentclientprotocol/sdk": "$CODEX_ACP_SDK", "@openai/codex": "$CODEX_CLI_VERSION" }
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
# Likewise the Codex CLI that codex-acp runs.
ln -sfn "$ACP_DIR/node_modules/.bin/codex" "$BIN/codex"

# Grok Build, one signed binary per version, checked against the pinned hash.
GROK_DIR="$VENDOR/grok-$GROK_VERSION"
if [ ! -x "$GROK_DIR/grok" ]; then
  tmp=$(mktemp -d "$VENDOR/.grok.XXXXXX")
  trap 'rm -rf "$tmp"' EXIT
  echo "downloading Grok $GROK_VERSION"
  /usr/bin/curl -fsSL -o "$tmp/grok.gz" "https://x.ai/cli/grok-$GROK_VERSION-macos-aarch64.gz"
  got=$(/usr/bin/shasum -a 256 "$tmp/grok.gz" | cut -d' ' -f1)
  [ "$got" = "$GROK_SHA256" ] || { echo "Grok download checksum mismatch: $got" >&2; exit 1; }
  /usr/bin/gzip -dc "$tmp/grok.gz" > "$tmp/grok"
  chmod 755 "$tmp/grok"
  "$tmp/grok" --version </dev/null >/dev/null
  rm -f "$tmp/grok.gz"
  rm -rf "$GROK_DIR"
  mv "$tmp" "$GROK_DIR"
  trap - EXIT
fi
ln -sfn "$GROK_DIR/grok" "$BIN/grok"

# The Black 4 connector: every agent's MCP server (agentctl passes mcp/black4 to
# buzz-acp). Its one dependency, @noble/curves, is pinned with integrity hashes
# in package-lock.json and installed with npm ci; reinstalled only when the
# lockfile changes.
CONNECTOR="$SRC/bridge/black4-agent-mcp"
MCP_DIR="$VENDOR/black4-agent-mcp"
if [ -f "$CONNECTOR/black4-agent-mcp.mjs" ]; then
  want_mcp=$(/usr/bin/shasum -a 256 "$CONNECTOR/package-lock.json" | cut -d' ' -f1)
  if [ "$(cat "$MCP_DIR/.installed" 2>/dev/null || true)" != "$want_mcp" ] || [ ! -f "$MCP_DIR/node_modules/@noble/curves/package.json" ]; then
    echo "installing the Black 4 connector's dependencies"
    tmp=$(mktemp -d "$VENDOR/.mcp.XXXXXX")
    trap 'rm -rf "$tmp"' EXIT
    cp "$CONNECTOR/package.json" "$CONNECTOR/package-lock.json" "$tmp/"
    (cd "$tmp" && npm ci --omit=dev --no-fund --no-audit --loglevel=error)
    echo "$want_mcp" > "$tmp/.installed"
    rm -rf "$MCP_DIR.old"
    if [ -d "$MCP_DIR" ]; then mv "$MCP_DIR" "$MCP_DIR.old"; fi
    mv "$tmp" "$MCP_DIR"
    rm -rf "$MCP_DIR.old"
    trap - EXIT
  fi
  cp "$CONNECTOR/black4-agent-mcp.mjs" "$MCP_DIR/black4-agent-mcp.mjs.tmp"
  mv "$MCP_DIR/black4-agent-mcp.mjs.tmp" "$MCP_DIR/black4-agent-mcp.mjs"
  mkdir -p "$ROOT/mcp"
  cat > "$ROOT/mcp/black4.tmp" <<'SH'
#!/bin/sh
# The Black 4 MCP for this machine's agents. buzz-acp starts it with the
# agent's key and owner attestation in the environment.
ROOT=$(cd "$(dirname "$0")/.." && pwd)
exec "$ROOT/bin/node" "$ROOT/vendor/black4-agent-mcp/black4-agent-mcp.mjs" "$@"
SH
  chmod 755 "$ROOT/mcp/black4.tmp"
  mv "$ROOT/mcp/black4.tmp" "$ROOT/mcp/black4"
  echo "Black 4 connector installed at $ROOT/mcp/black4"
fi
if [ -f "$SRC/machine/agentctl" ]; then
  cp "$SRC/machine/agentctl" "$BIN/agentctl.tmp"
  chmod 755 "$BIN/agentctl.tmp"
  mv "$BIN/agentctl.tmp" "$BIN/agentctl"
  echo "agentctl installed"
fi

if [ -n "${MACHINE_NAME:-}" ]; then
  printf '{"name": "%s"}\n' "$MACHINE_NAME" > "$ROOT/machine.json"
fi

echo "node $("$BIN/node" --version), $want, grok $GROK_VERSION"
echo "setup done"
