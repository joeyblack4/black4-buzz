// ---- Updates nobody can miss ---------------------------------------------------
// Everyone works on the released plugin (Joey, 2026-11-28: "We can't have
// people operating on some of them on the latest plugin and some of them
// not."). Buzz finds the update on `stable` by itself and shows a toast once;
// "Later" hides it until Buzz restarts. This watch serves it again: a notice
// with Update now, back an hour after it is closed (every 15 minutes once the
// update is overdue), and on every launch. Buzz still installs only what the
// person approves, so the strongest step left is refusal: a day after the
// update first showed on this device, Black 4's agent tools answer "update
// first" until it is installed. The clock is kept on the device, by installed
// revision, so a restart neither resets it nor forgives it.

export const UPDATE_SEEN_KEY = "ai.black4.update-seen";
/** How often the watch asks Buzz to look for a new release itself. */
export const UPDATE_CHECK_MS = 30 * 60 * 1000;
/** A closed reminder comes back after this; sooner once the update is overdue. */
export const UPDATE_REMIND_MS = 60 * 60 * 1000;
export const UPDATE_OVERDUE_REMIND_MS = 15 * 60 * 1000;
/** From the first sight of an update on this device to agent tools refusing. */
export const UPDATE_GRACE_MS = 24 * 60 * 60 * 1000;
export const UPDATE_REQUIRED_TEXT =
  "The Black 4 plugin in this Buzz is out of date, so Black 4's tools are paused here until it is updated. " +
  "Ask the person to update it in Buzz: choose Update now on the \"Update Black 4 now\" notice or in Settings → Black 4, " +
  "or Update next to Black 4 in Settings → Plugins. Buzz installs it in a few seconds; then try again.";

/**
 * The update watch for one activation. `updates` is Buzz's
 * pluginInstaller.updates for this plugin, `notices` its notices service;
 * either may be missing on an older Buzz, and then the watch does nothing.
 * `storage` is the device's localStorage.
 */
export function createUpdateWatch({ pluginId, updates, notices, storage, now = () => Date.now(), timers = globalThis, onChange = () => {} }) {
  let pending = null; // { token, installed, candidate, since }
  let showing = null; // AbortController of the notice on screen
  let closedAt = null;
  let remindTimer = null;
  let graceTimer = null; // fires when the day is up, so the screen flips as the tools pause
  let checkTimer = null;
  let stopped = false;

  const readSeen = () => {
    try {
      const value = JSON.parse(storage?.getItem(UPDATE_SEEN_KEY) ?? "null");
      return value && typeof value.installed === "string" && Number.isFinite(value.since) ? value : null;
    } catch { return null; }
  };
  const writeSeen = (value) => { try { storage?.setItem(UPDATE_SEEN_KEY, JSON.stringify(value)); } catch {} };

  const overdue = () => Boolean(pending) && now() - pending.since >= UPDATE_GRACE_MS;

  /** Reads Buzz's update snapshot. Only a candidate for this plugin counts:
   * its absence is not proof of being current, so the clock is kept. */
  const read = () => {
    let snapshot;
    try { snapshot = updates?.getSnapshot?.(); } catch { return; }
    const candidate = snapshot?.candidates?.find?.((entry) => entry?.id === pluginId);
    if (!candidate) {
      if (pending) { pending = null; hide(); disarmGrace(); onChange(); }
      return;
    }
    const seen = readSeen();
    // Out of date since the first update seen for this installed revision: a
    // newer release on top of an ignored one does not restart the clock.
    const since = seen && seen.installed === candidate.installedRevision ? seen.since : now();
    if (!seen || seen.installed !== candidate.installedRevision) writeSeen({ installed: candidate.installedRevision, since });
    const changed = !pending || pending.candidate !== candidate.candidateRevision || pending.token !== candidate.token;
    pending = { token: candidate.token, installed: candidate.installedRevision, candidate: candidate.candidateRevision, since };
    if (changed) onChange();
    armGrace();
    schedule();
  };

  /** The moment the tools pause is the moment the screen says so: when the
   * day runs out while Buzz is open, Settings flips to "Update required" and
   * the notice on screen is replaced by the one that says the tools are
   * paused, without a restart. Timed in hops of at most an hour, so a laptop
   * asleep past the deadline catches up on its first hop. */
  const disarmGrace = () => { if (graceTimer) { timers.clearTimeout(graceTimer); graceTimer = null; } };
  const armGrace = () => {
    disarmGrace();
    if (stopped || !pending || overdue()) return;
    const wait = pending.since + UPDATE_GRACE_MS - now();
    graceTimer = timers.setTimeout(() => {
      graceTimer = null;
      if (stopped || !pending) return;
      if (!overdue()) return armGrace();
      onChange();
      if (showing) { hide(); schedule(); }
    }, Math.max(0, Math.min(wait, UPDATE_REMIND_MS)));
  };

  /** Opens Buzz's Update review for this plugin; a stale token is refreshed once. */
  const install = async () => {
    if (!pending || typeof updates?.queueUpdates !== "function") return false;
    try {
      if (updates.queueUpdates([pending.token])) return true;
      await updates.refresh?.();
      read();
      return Boolean(pending && updates.queueUpdates([pending.token]));
    } catch { return false; }
  };

  const hide = () => { showing?.abort(); showing = null; };

  const show = () => {
    if (stopped || showing || !pending || typeof notices?.show !== "function") return;
    const late = overdue();
    const controller = new AbortController();
    showing = controller;
    let shown;
    try {
      shown = notices.show({
        title: late ? "Update Black 4 now" : "Update Black 4",
        description: late
          ? "This Buzz is on an old version of Black 4, so Black 4's tools are paused here until you update. It takes a few seconds."
          : "A new version of Black 4 is ready. Update now so you and your team work on the same version. Black 4's tools pause on old versions after a day.",
        actions: [{ id: "update", label: "Update now", prominent: true }, { id: "later", label: "Later" }],
      }, { signal: controller.signal });
    } catch { showing = null; return; }
    Promise.resolve(shown).then((picked) => {
      if (showing === controller) showing = null;
      if (controller.signal.aborted || stopped) return;
      closedAt = now();
      if (picked === "update") void install();
      schedule();
    }, () => { if (showing === controller) showing = null; });
  };

  /** Shows the notice now when it is due, else when it will be. */
  const schedule = () => {
    if (stopped || !pending) return;
    if (remindTimer) { timers.clearTimeout(remindTimer); remindTimer = null; }
    if (showing) return;
    const wait = closedAt === null ? 0 : closedAt + (overdue() ? UPDATE_OVERDUE_REMIND_MS : UPDATE_REMIND_MS) - now();
    if (wait <= 0) return show();
    remindTimer = timers.setTimeout(() => { remindTimer = null; show(); }, Math.min(wait, UPDATE_REMIND_MS));
  };

  const check = () => {
    if (stopped) return;
    try { Promise.resolve(updates?.refresh?.()).then(read, () => {}); } catch {}
  };

  let unsubscribe = () => {};
  const start = () => {
    if (!updates) return;
    try { unsubscribe = updates.subscribe?.(read) ?? unsubscribe; } catch {}
    read();
    check();
    checkTimer = timers.setInterval(check, UPDATE_CHECK_MS);
  };

  return {
    start,
    stop() {
      stopped = true;
      hide();
      unsubscribe();
      if (remindTimer) timers.clearTimeout(remindTimer);
      disarmGrace();
      if (checkTimer) timers.clearInterval(checkTimer);
    },
    /** null when current (or unknown); else the update and whether it is overdue. */
    status: () => (pending ? { since: pending.since, overdue: overdue() } : null),
    /** The refusal agent tools answer with once the update is overdue. */
    refusal: () => (overdue() ? UPDATE_REQUIRED_TEXT : null),
    install,
  };
}
