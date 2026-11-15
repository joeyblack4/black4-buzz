#!/bin/sh
# Black 4 in Buzz. Nothing here is needed to use the plugin: install it from
# Buzz (Settings > Plugins > install from GitHub, joeyblack4/black4-buzz,
# ref stable, path plugins/black4), or open
#   buzz://plugin-install?repository=joeyblack4%2Fblack4-buzz&ref=stable&path=plugins%2Fblack4
#
#   install.sh                          opens that link: Buzz's install review
#   install.sh --hardware <user>@<address>
#                                       admin, legacy: direct SSH to a machine's
#                                       agentctl (makes a key for the machines and
#                                       the `commerce` SSH alias, and prints the
#                                       line to send the machine's admin). The
#                                       plugin does not use it.
#   install.sh --check-hardware         admin, legacy: asks the machine over SSH
#                                       what it can run
#
# Buzz shows what the plugin may do, and nothing is installed until you choose
# Install. The admin gives you <user>@<address>; neither is written in this
# repository.
set -eu

REPOSITORY="${BLACK4_BUZZ_REPOSITORY:-joeyblack4/black4-buzz}"
REF="${BLACK4_BUZZ_REF:-stable}"
SSH_DIR="${BLACK4_SSH_DIR:-$HOME/.ssh}"
ALIAS=commerce                       # the SSH alias for the Commerce Mac (legacy admin access)
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

# ---- legacy admin access: direct SSH to a machine's agentctl -----------------
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
    # At the top: ssh keeps the first value it finds for each setting, so a
    # later `Host *` (say, with another User) cannot change this entry.
    tmp=$(mktemp "$SSH_DIR/.config.XXXXXX")
    {
      echo "$BEGIN"
      echo "Host $ALIAS"
      echo "  HostName $address"
      echo "  User $user"
      echo "  IdentityFile $KEY"
      echo "  IdentitiesOnly yes"
      echo "  StrictHostKeyChecking accept-new"
      echo "$END"
      echo
      awk -v b="$BEGIN" -v e="$END" '$0 == b { skip = 1; next } skip && $0 == e { skip = 0; drop = 1; next } !skip && !(drop && $0 == "") { print; drop = 0 }' "$config"
    } > "$tmp"
    chmod 600 "$tmp"
    mv "$tmp" "$config"
    echo "SSH alias '$ALIAS' points at $user@$address (in $config)."
  fi

  echo
  echo "Send this one line to your Black 4 admin (it is a public key, safe to share):"
  echo
  cat "$KEY.pub"
  echo
  echo "Once the admin says you are added, run this again with --check-hardware."
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

if [ -n "${1:-}" ]; then
  echo "usage: install.sh [--hardware <user>@<address> | --check-hardware]" >&2
  exit 2
fi

open_review black4
echo "After you choose Install, turn Black 4 on, then Settings > Black 4 > Sign in."
echo "Black 4 staff: then Agents > New agent > Black 4 hardware."
