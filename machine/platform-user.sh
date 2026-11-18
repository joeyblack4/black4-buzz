#!/bin/sh
# Sets up a Black 4 machine's customer-facing runner: the macOS user that runs
# platform agents (account managers), apart from the staff agents. Run it once,
# on the machine, from the admin account that runs ~/workforce, with sudo (it
# asks for that account's password):
#   sudo sh machine/platform-user.sh [user]      (user: b4platform)
# Then deploy as usual (machine/deploy.sh <machine> <name>): setup.sh installs
# the same release for that user too, as that user.
#
# What it does, and why (agentctl, "the customer-facing profile"):
#   1. Makes the user: standard (not an admin), hidden from the login window,
#      with a random password nobody keeps (nothing logs in as it).
#   2. Closes the admin's home and ~/workforce to everyone else (mode 700), so
#      that user can read none of the staff agents' keys, sign-ins or logs.
#   3. Lets the admin run commands as that user without a password (one
#      sudoers rule, checked with visudo): how the main runner forwards
#      requests to the customer-facing runner, and how setup.sh installs it.
#      The other way, that user gets nothing: it has no sudo at all.
#   4. Copies the vendored Buzz (buzz-acp and the buzz CLI) into that user's
#      own ~/workforce/vendor, since it cannot read the admin's.
#   5. Writes ~/workforce/runner.json for the main runner, naming that user.
#   6. Checks the separation: that user cannot list the staff agents.
set -eu
PLATFORM_USER=${1:-b4platform}
case "$PLATFORM_USER" in ""|*[!a-z0-9_-]*) echo "the user name may use a-z, 0-9, _ and -" >&2; exit 1 ;; esac
[ "$(id -u)" = 0 ] || { echo "run it with sudo: sudo sh machine/platform-user.sh" >&2; exit 1; }
ADMIN=${SUDO_USER:-}
[ -n "$ADMIN" ] && [ "$ADMIN" != root ] || { echo "run it with sudo from the admin account that runs ~/workforce" >&2; exit 1; }
ADMIN_HOME=$(dscl . -read "/Users/$ADMIN" NFSHomeDirectory | awk '{print $2}')
[ -d "$ADMIN_HOME/workforce" ] || { echo "$ADMIN has no ~/workforce: run machine/deploy.sh first" >&2; exit 1; }
BUZZ_VENDOR=buzz-0.5.30   # machine/pins.json harness.vendorDir
[ -x "$ADMIN_HOME/workforce/vendor/$BUZZ_VENDOR/Buzz.app/Contents/MacOS/buzz-acp" ] || { echo "no vendored $BUZZ_VENDOR in $ADMIN_HOME/workforce/vendor" >&2; exit 1; }

# 1. The user.
if id "$PLATFORM_USER" >/dev/null 2>&1; then
  echo "user $PLATFORM_USER exists"
else
  PASSWORD=$(/usr/bin/openssl rand -base64 33)
  /usr/sbin/sysadminctl -addUser "$PLATFORM_USER" -fullName "Black 4 customer-facing agents" -password "$PASSWORD" -home "/Users/$PLATFORM_USER" -shell /bin/zsh
  unset PASSWORD
  /usr/bin/dscl . -create "/Users/$PLATFORM_USER" IsHidden 1
  /usr/sbin/createhomedir -c -u "$PLATFORM_USER" >/dev/null
  echo "made user $PLATFORM_USER"
fi
if /usr/sbin/dseditgroup -o checkmember -m "$PLATFORM_USER" admin >/dev/null 2>&1; then
  echo "$PLATFORM_USER is an admin; it must not be" >&2; exit 1
fi
PLATFORM_HOME=$(dscl . -read "/Users/$PLATFORM_USER" NFSHomeDirectory | awk '{print $2}')
chown "$PLATFORM_USER" "$PLATFORM_HOME"
chmod 700 "$PLATFORM_HOME"

# 2. The admin's home and runner, closed to every other user.
chmod 700 "$ADMIN_HOME" "$ADMIN_HOME/workforce"

# 3. The admin may run commands as that user (and only as that user).
RULE=/etc/sudoers.d/black4-platform
printf '%s ALL=(%s) NOPASSWD: ALL\n' "$ADMIN" "$PLATFORM_USER" > "$RULE.tmp"
chmod 440 "$RULE.tmp"
/usr/sbin/visudo -cf "$RULE.tmp" >/dev/null || { rm -f "$RULE.tmp"; echo "the sudoers rule did not check out" >&2; exit 1; }
mv "$RULE.tmp" "$RULE"

# 4. Its own copy of the vendored Buzz, linked where setup.sh expects it.
PROOT="$PLATFORM_HOME/workforce"
mkdir -p "$PROOT/vendor" "$PROOT/bin"
rm -rf "$PROOT/vendor/$BUZZ_VENDOR"
/usr/bin/ditto "$ADMIN_HOME/workforce/vendor/$BUZZ_VENDOR" "$PROOT/vendor/$BUZZ_VENDOR"
ln -sfn "$PROOT/vendor/$BUZZ_VENDOR/Buzz.app/Contents/MacOS/buzz-acp" "$PROOT/bin/buzz-acp"
ln -sfn "$PROOT/vendor/$BUZZ_VENDOR/Buzz.app/Contents/MacOS/buzz" "$PROOT/bin/buzz"
chown -R "$PLATFORM_USER" "$PROOT"
chmod 700 "$PROOT"

# 5. The main runner's note of it.
printf '{"platform": {"user": "%s", "agentctl": "%s/bin/agentctl"}}\n' "$PLATFORM_USER" "$PROOT" > "$ADMIN_HOME/workforce/runner.json"
chown "$ADMIN" "$ADMIN_HOME/workforce/runner.json"

# 6. The separation, checked.
if /usr/bin/sudo -n -u "$PLATFORM_USER" /bin/ls "$ADMIN_HOME/workforce/agents" >/dev/null 2>&1; then
  echo "FAILED: $PLATFORM_USER can read $ADMIN_HOME/workforce/agents" >&2; exit 1
fi
/usr/bin/sudo -n -u "$ADMIN" /usr/bin/sudo -n -u "$PLATFORM_USER" /usr/bin/true || { echo "FAILED: $ADMIN cannot run commands as $PLATFORM_USER" >&2; exit 1; }
echo "done: $PLATFORM_USER cannot read $ADMIN's runner, and $ADMIN reaches it with sudo -u $PLATFORM_USER."
echo "Next: machine/deploy.sh <machine> <name> installs its runner."
