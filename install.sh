#!/bin/sh
# Puts Black 4 in Buzz on a Mac (or any computer with a POSIX shell).
#
#   install.sh                          the Black 4 plugin: installs the sign-in
#                                       bridge, then opens Buzz's install review
#   install.sh --hardware <user>@<address>
#                                       Black 4 hardware: makes this computer's
#                                       key for the machines, the `commerce` SSH
#                                       alias, prints the line to send an admin,
#                                       and opens the hardware plugin's review
#   install.sh --check-hardware         after the admin added you: asks the
#                                       machine what it can run
#   install.sh --bridge-only            repairs the bridge, opens nothing
#
# Buzz shows what each plugin may do, and nothing is installed until you choose
# Install. Run it again any time: it only repairs what is missing. The admin
# gives you <user>@<address>; neither is written in this repository.
set -eu

HERE="$(cd "$(dirname "$0")" 2>/dev/null && pwd || pwd)"
BRIDGE_HOME="${BLACK4_MCP_BRIDGE_HOME:-$HOME/.black4/mcp-bridge}"
BIN="$HOME/.local/bin"
REPOSITORY="${BLACK4_BUZZ_REPOSITORY:-joeyblack4/black4-buzz}"
REF="${BLACK4_BUZZ_REF:-stable}"
SSH_DIR="${BLACK4_SSH_DIR:-$HOME/.ssh}"
ALIAS=commerce                       # what plugins/hardware/manifest.json runs: ssh ... commerce
KEY="$SSH_DIR/black4_hardware"
BEGIN="# >>> black4-hardware (install.sh; edits inside are replaced) >>>"
END="# <<< black4-hardware <<<"

open_review() {
  link="buzz://plugin-install?repository=$(printf %s "$REPOSITORY" | sed 's|/|%2F|g')&ref=$REF&path=plugins%2F$1"
  echo "Opening Buzz to review and install the plugin:"
  echo "  $link"
  if [ -n "${BLACK4_NO_OPEN:-}" ]; then return 0; fi
  if command -v open >/dev/null 2>&1; then open "$link" 2>/dev/null && return 0; fi
  if command -v xdg-open >/dev/null 2>&1; then xdg-open "$link" 2>/dev/null && return 0; fi
  echo "Open that link yourself once Buzz is installed."
}

# ---- Black 4 hardware: this computer's side -----------------------------------
hardware() {
  target=$1
  case "$target" in
    *@*) user=${target%%@*}; address=${target#*@} ;;
    *) echo "usage: install.sh --hardware <user>@<address>  (your admin gives you both)" >&2; exit 2 ;;
  esac
  printf %s "$user" | grep -Eq '^[a-z_][a-z0-9._-]{0,31}$' || { echo "that user name does not look right: $user" >&2; exit 2; }
  printf %s "$address" | grep -Eq '^[A-Za-z0-9.:-]{1,253}$' || { echo "that address does not look right: $address" >&2; exit 2; }
  command -v ssh >/dev/null 2>&1 && command -v ssh-keygen >/dev/null 2>&1 || { echo "OpenSSH (ssh and ssh-keygen) is required." >&2; exit 1; }

  mkdir -p "$SSH_DIR"
  chmod 700 "$SSH_DIR"
  # A key only for the machines. No passphrase: Buzz runs ssh without a
  # terminal to ask. On the machine it can only run agentctl.
  if [ ! -f "$KEY" ]; then
    ssh-keygen -q -t ed25519 -N "" -C "black4-hardware" -f "$KEY"
  fi

  config="$SSH_DIR/config"
  [ -f "$config" ] || { : > "$config"; chmod 600 "$config"; }
  # Someone's own `Host commerce` (written by hand, outside our markers) wins:
  # ssh uses the first match, so leave it alone and say so.
  if awk -v b="$BEGIN" -v e="$END" -v a="$ALIAS" '
      $0 == b { inside = 1; next } $0 == e { inside = 0; next }
      !inside && tolower($1) == "host" { for (i = 2; i <= NF; i++) if ($i == a) found = 1 }
      END { exit !found }' "$config"; then
    echo "Your $config already has its own 'Host $ALIAS'; leaving it as it is."
  else
    tmp=$(mktemp "$SSH_DIR/.config.XXXXXX")
    awk -v b="$BEGIN" -v e="$END" '$0 == b { skip = 1 } !skip { print } $0 == e { skip = 0 }' "$config" > "$tmp"
    {
      [ -s "$tmp" ] && [ "$(tail -c 1 "$tmp")" != "" ] && echo
      echo "$BEGIN"
      echo "Host $ALIAS"
      echo "  HostName $address"
      echo "  User $user"
      echo "  IdentityFile $KEY"
      echo "  IdentitiesOnly yes"
      echo "  StrictHostKeyChecking accept-new"
      echo "$END"
    } >> "$tmp"
    chmod 600 "$tmp"
    mv "$tmp" "$config"
    echo "SSH alias '$ALIAS' points at $user@$address (in $config)."
  fi

  echo
  echo "Send this one line to your Black 4 admin (it is a public key, safe to share):"
  echo
  cat "$KEY.pub"
  echo
  open_review hardware
  echo "Once the admin says you are added, run: sh install.sh --check-hardware"
}

check_hardware() {
  reply=$(printf '%s\n' '{"op":"machine.status"}' | ssh -o BatchMode=yes -o ConnectTimeout=10 "$ALIAS" workforce/bin/agentctl 2>&1) || true
  case "$reply" in
    *'"ok": true'*|*'"ok":true'*) echo "Black 4 hardware reached: $reply" ;;
    *"Permission denied"*) echo "The machine refused this key. Has the admin added the line install.sh --hardware printed?" >&2; exit 1 ;;
    *) echo "Could not reach the machine: $reply" >&2; echo "Are you on the company network (Tailscale on)?" >&2; exit 1 ;;
  esac
}

case "${1:-}" in
  --hardware) hardware "${2:-}"; exit 0 ;;
  --check-hardware) check_hardware; exit 0 ;;
esac

# ---- the Black 4 plugin and its sign-in bridge --------------------------------
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

# Buzz starts the bridge by name, so your login shell must find it.
SHELL_BIN="${SHELL:-/bin/zsh}"
if ! "$SHELL_BIN" -lic 'command -v black4-mcp-bridge' >/dev/null 2>&1; then
  echo "Your shell does not have $BIN on its PATH yet, so Buzz will not find the bridge." >&2
  echo "Add this line to ~/.zprofile, then quit and reopen Buzz:" >&2
  echo "  export PATH=\"\$HOME/.local/bin:\$PATH\"" >&2
fi

[ "${1:-}" = "--bridge-only" ] && exit 0

open_review black4
echo "After you choose Install, turn the plugin on and finish the Black 4 sign-in in your browser."
echo "Then in Settings > Black 4, choose Link my agents."
