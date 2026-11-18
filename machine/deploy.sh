#!/bin/sh
# Puts this checkout's machine side on a Black 4 machine and runs setup there:
#   machine/deploy.sh <ssh-host> [machine-name]
# It copies setup.sh, agentctl, door.mjs, qwen-account.mjs, pins.json, staff.json and the Black 4 connector to
# ~/workforce/.staging on the machine and runs setup.sh from there, which ends
# with `agentctl doctor` and fails when the machine cannot run agents. Safe to
# run again. Running agents keep running; restart them (agentctl op "start") to pick
# up a new connector or agentctl behaviour that applies at start.
# BLACK4_WORKFORCE_ROOT=workforce-dev puts a second runner in ~/workforce-dev
# on the machine instead (a folder under the machine user's home), with its own
# agents, sign-ins and cron lines; the real ~/workforce is not touched.
set -eu
HOST=${1:?usage: machine/deploy.sh <ssh-host> [machine-name]}
NAME=${2:-}
cd "$(dirname "$0")/.."
DIR=${BLACK4_WORKFORCE_ROOT:-workforce}
case "$NAME" in *[!A-Za-z0-9._-]*) echo "machine name may use letters, digits, . _ -" >&2; exit 1 ;; esac
case "$DIR" in ""|.*|*[!A-Za-z0-9._-]*) echo "BLACK4_WORKFORCE_ROOT is a folder name under the machine's home: letters, digits, . _ -" >&2; exit 1 ;; esac
COPYFILE_DISABLE=1 tar -czf - machine/setup.sh machine/agentctl machine/door.mjs machine/qwen-account.mjs machine/pins.json machine/staff.json machine/platform-user.sh \
    bridge/black4-agent-mcp/black4-agent-mcp.mjs bridge/black4-agent-mcp/package.json bridge/black4-agent-mcp/package-lock.json |
  ssh "$HOST" "set -e; R=\$HOME/$DIR; S=\$R/.staging; rm -rf \"\$S\"; mkdir -p \"\$S\"; tar -xzf - -C \"\$S\"; BLACK4_WORKFORCE_ROOT=\"\$R\" MACHINE_NAME='$NAME' sh \"\$S/machine/setup.sh\""
