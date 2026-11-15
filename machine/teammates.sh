#!/bin/sh
# Lets a teammate's Buzz reach a Black 4 machine with a key that can only run
# agentctl. Run by someone who already has access:
#
#   machine/teammates.sh --host <ssh-host> add <label> '<public key line>'
#   machine/teammates.sh --host <ssh-host> list
#   machine/teammates.sh --host <ssh-host> remove <label>
#
# <label> names the teammate (lowercase letters, digits, . _ -; e.g. "chris").
# agentctl stores it as the creator of each agent they make. The public key
# line is what the teammate's `install.sh --hardware` printed.
#
# Each teammate gets one authorized_keys line:
#   command="<home>/workforce/bin/agentctl --caller <label>",restrict,... <key> black4-teammate:<label>
# The forced command replaces whatever the client asks to run, so the key gives
# no shell, no port, agent or X11 forwarding and no pty: only agentctl, which
# reads one JSON request on stdin. Without --host the script edits this
# computer's file (on the machine itself; AUTHORIZED_KEYS overrides the path,
# which is how the tests run it).
set -eu

if [ "${1:-}" = "--host" ]; then
  HOST=${2:?usage: machine/teammates.sh --host <ssh-host> add|list|remove ...}
  shift 2
  # Every argument is checked below to hold only [A-Za-z0-9+/=._:-], so it can
  # cross the remote shell unquoted. The script itself goes on stdin.
  for arg in "$@"; do
    case "$arg" in *[!A-Za-z0-9+/=._:@\ -]*) echo "unexpected characters in: $arg" >&2; exit 2 ;; esac
  done
  quoted=""
  for arg in "$@"; do quoted="$quoted '$arg'"; done
  exec ssh "$HOST" "sh -s --$quoted" < "$0"
fi

FILE=${AUTHORIZED_KEYS:-$HOME/.ssh/authorized_keys}
AGENTCTL="$HOME/workforce/bin/agentctl"
MARK="black4-teammate:"
OPTIONS="restrict,no-port-forwarding,no-agent-forwarding,no-pty,no-X11-forwarding,no-user-rc"

usage() { echo "usage: machine/teammates.sh [--host <ssh-host>] add <label> '<public key line>' | list | remove <label>" >&2; exit 2; }
has_label() { [ -f "$FILE" ] && awk -v want="$MARK$1" '$NF == want { found = 1 } END { exit !found }' "$FILE"; }
without_label() { awk -v want="$MARK$1" '$NF != want' "$FILE"; }
label_ok() { printf %s "$1" | grep -Eq '^[a-z0-9][a-z0-9._-]{0,31}$'; }

# Rewrites the file atomically, mode 600, keeping the previous one beside it.
replace() {
  dir=$(dirname "$FILE")
  mkdir -p "$dir" && chmod 700 "$dir"
  tmp=$(mktemp "$dir/.authorized_keys.XXXXXX")
  cat > "$tmp"
  chmod 600 "$tmp"
  if [ -f "$FILE" ]; then cp -p "$FILE" "$FILE.black4-previous"; fi
  mv "$tmp" "$FILE"
}

cmd=${1:-}
[ -n "$cmd" ] || usage
shift
touch_file() { [ -f "$FILE" ] || : | replace; }

case "$cmd" in
  add)
    [ $# -ge 2 ] || usage
    label=$1; shift
    label_ok "$label" || { echo "label must be lowercase letters, digits, . _ - (32 at most): $label" >&2; exit 2; }
    # "type blob [comment]", given as one argument or several.
    set -f
    set -- $*
    type=${1:-}; blob=${2:-}
    case "$type" in
      ssh-ed25519|ecdsa-sha2-nistp256|ecdsa-sha2-nistp384|ecdsa-sha2-nistp521|sk-ssh-ed25519@openssh.com|sk-ecdsa-sha2-nistp256@openssh.com|ssh-rsa) ;;
      *) echo "that is not an SSH public key line (it should start with ssh-ed25519)" >&2; exit 2 ;;
    esac
    printf %s "$blob" | grep -Eq '^[A-Za-z0-9+/]{40,}={0,2}$' || { echo "that public key looks cut off; paste the whole line" >&2; exit 2; }
    if command -v ssh-keygen >/dev/null 2>&1; then
      check=$(mktemp)
      printf '%s %s\n' "$type" "$blob" > "$check"
      ssh-keygen -lf "$check" >/dev/null 2>&1 || { rm -f "$check"; echo "ssh-keygen does not accept that public key" >&2; exit 2; }
      rm -f "$check"
    fi
    touch_file
    if has_label "$label"; then echo "$label already has a key here; remove it first to replace it" >&2; exit 1; fi
    if grep -qF " $blob" "$FILE"; then echo "that key is already in $FILE (perhaps unrestricted); not adding it twice" >&2; exit 1; fi
    { cat "$FILE"; printf 'command="%s --caller %s",%s %s %s %s%s\n' "$AGENTCTL" "$label" "$OPTIONS" "$type" "$blob" "$MARK" "$label"; } | replace
    echo "added $label: their Buzz can now run agentctl here, and nothing else"
    ;;
  list)
    [ -f "$FILE" ] || exit 0
    awk -v mark="$MARK" 'index($NF, mark) == 1' "$FILE" | while IFS= read -r line; do
      label=${line##* "$MARK"}
      key=$(printf %s "$line" | awk '{ for (i = 1; i < NF; i++) if ($i ~ /^(ssh-|ecdsa-|sk-)/) { print $i, $(i + 1); exit } }')
      fp=$(printf '%s\n' "$key" | ssh-keygen -lf - 2>/dev/null | awk '{ print $2 }' || true)
      printf '%s\t%s\n' "$label" "${fp:-?}"
    done
    ;;
  remove)
    [ $# -eq 1 ] || usage
    label=$1
    label_ok "$label" || usage
    has_label "$label" || { echo "no key for $label here" >&2; exit 1; }
    without_label "$label" | replace
    echo "removed $label; agents they created keep running (agentctl list shows them)"
    ;;
  *) usage ;;
esac
