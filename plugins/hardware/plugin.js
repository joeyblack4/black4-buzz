// Black 4 Hardware plugin for Buzz 1.0 (API v1: one self-contained ES module).
//
// It adds one hosted agent type, "Black 4 hardware", to the New agent dialog.
// An agent of this type is created and seen in the owner's Buzz like any
// other, but it runs on a Black 4 machine: that machine makes and keeps the
// agent's key, and runs it with Buzz's own headless harness, so it answers
// while this Buzz is closed.
//
// The plugin holds no key and no agent state. Each step is one request to the
// machine's `agentctl`, reached over the owner's own SSH access (the process
// the manifest declares). Buzz signs the owner's attestation; the plugin only
// carries it. Harness sign-in belongs to the machine: once a harness is signed
// in there, every agent on that machine that runs it uses that sign-in.

export const inject = ["react", "host", "agents"];

/** Black 4 machines. Adding one is one entry here plus one manifest
 * `processes` entry whose id is `process`. */
export const MACHINES = [
  { id: "commerce", label: "Commerce Mac", process: "commerce" },
];
const DEFAULT_MACHINE = "commerce";

const TIMEOUT_MS = 45 * 1000;
const STATUS_TIMEOUT_MS = 12 * 1000;
const STATUS_TTL_MS = 20 * 1000;
const UNREACHABLE_TTL_MS = 4 * 1000;
const LOGIN_TIMEOUT_MS = 60 * 1000;

export const HARNESSES = [
  { id: "claude", label: "Claude Code" },
  { id: "codex", label: "Codex" },
  { id: "grok", label: "Grok Build" },
  { id: "goose", label: "Goose" },
];
const ANSWERS = [
  { id: "anyone", label: "Everyone in the community" },
  { id: "owner-only", label: "Only me" },
];

export const defaults = () => ({
  machine: DEFAULT_MACHINE, harness: "claude", model: "", respondTo: "anyone", instructions: "",
});

/** The machine an id or a config names. Unknown or missing (an agent made
 * before machines were a choice) resolves to the default machine. */
export function machineOf(value) {
  const id = typeof value === "string" ? value : value?.id ?? value?.machine;
  return MACHINES.find((entry) => entry.id === id) ?? MACHINES.find((entry) => entry.id === DEFAULT_MACHINE);
}

export const harnessLabel = (id) => HARNESSES.find((entry) => entry.id === id)?.label;

/** One request to a machine's agentctl: JSON in on stdin, one JSON reply out.
 * `spawn` is `ctx.host.spawn`; `machine` is a machine, its id or a config.
 * The reply is the last stdout line, so a login banner before it is ignored.
 * Rejects with the machine's own error text. */
export async function ask(spawn, machine, request, { signal, timeoutMs = TIMEOUT_MS } = {}) {
  const target = machineOf(machine);
  if (typeof spawn !== "function") throw new Error("This Buzz cannot start processes, so it cannot reach Black 4 hardware.");
  signal?.throwIfAborted?.();
  let out = "";
  let err = "";
  let timedOut = false;
  const text = (chunk) => (typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
  const child = await spawn(target.process, {
    onStdout: (chunk) => { out += text(chunk); },
    onStderr: (chunk) => { err += text(chunk); },
  });
  const stop = () => { try { Promise.resolve(child.kill?.()).catch(() => {}); } catch {} };
  const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
  const abort = () => stop();
  signal?.addEventListener?.("abort", abort, { once: true });
  try {
    await child.write(JSON.stringify(request));
    await child.end?.();
    await child.exited;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener?.("abort", abort);
  }
  if (signal?.aborted) throw new DOMException("Cancelled.", "AbortError");
  if (timedOut) throw new Error(`The ${target.label} did not answer in time.`);
  const lines = out.split("\n").map((line) => line.trim()).filter(Boolean);
  let reply;
  try { reply = JSON.parse(lines.pop() || ""); } catch {
    throw new Error(`Could not reach the ${target.label}${err.trim() ? `: ${err.trim().slice(-300)}` : "."}`);
  }
  if (!reply?.ok) throw new Error(reply?.error || "The machine refused the request.");
  return reply;
}

const unsupported = (error) => /unknown op/i.test(String(error?.message ?? error));

/** Shared, briefly cached `machine.status` per machine. `read` never rejects:
 * it resolves `{ kind: "ok", harnesses }`, `{ kind: "unsupported" }` (the
 * machine predates the op) or `{ kind: "unreachable", error }`. Concurrent
 * reads share one request. */
export function statusReader(spawn, { ttlMs = STATUS_TTL_MS, timeoutMs = STATUS_TIMEOUT_MS, now = () => Date.now() } = {}) {
  const cache = new Map(); // machine id -> { at, status }
  const flight = new Map(); // machine id -> promise
  const listeners = new Set();
  const notify = (id) => { for (const listener of [...listeners]) listener(id); };
  const fresh = (id) => {
    const entry = cache.get(id);
    if (!entry) return undefined;
    const ttl = entry.status.kind === "unreachable" ? Math.min(ttlMs, UNREACHABLE_TTL_MS) : ttlMs;
    return now() - entry.at < ttl ? entry.status : undefined;
  };
  return {
    /** The cached status if still fresh; never calls the machine. */
    peek: (machine) => fresh(machineOf(machine).id),
    read(machine, { force = false } = {}) {
      const { id } = machineOf(machine);
      if (!force) {
        const hit = fresh(id);
        if (hit) return Promise.resolve(hit);
        if (flight.has(id)) return flight.get(id);
      }
      const request = ask(spawn, id, { op: "machine.status" }, { timeoutMs })
        .then((reply) => ({ kind: "ok", harnesses: Array.isArray(reply.harnesses) ? reply.harnesses : [] }))
        .catch((error) => (unsupported(error) ? { kind: "unsupported" } : { kind: "unreachable", error: String(error?.message ?? error) }))
        .then((status) => {
          if (flight.get(id) === request) flight.delete(id);
          cache.set(id, { at: now(), status });
          notify(id);
          return status;
        });
      flight.set(id, request);
      return request;
    },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  };
}

/** Harnesses to offer for a machine: those it reports installed once its
 * status has loaded, every harness otherwise. */
export function harnessOptions(status) {
  if (status?.kind !== "ok") return HARNESSES;
  return HARNESSES.filter((entry) => status.harnesses.some((row) => row?.id === entry.id && row.installed !== false));
}

/** The sign-in state of one harness on a machine, from its status (or
 * `undefined` while loading). */
export function signInState(status, harness) {
  if (!status) return { kind: "loading" };
  if (status.kind === "unreachable") return { kind: "unreachable", error: status.error };
  if (status.kind === "unsupported") return { kind: "unsupported" };
  const row = status.harnesses.find((entry) => entry?.id === harness);
  if (!row || row.installed === false) return { kind: "not-installed" };
  if (row.signedIn === true) return { kind: "signed-in", account: typeof row.account === "string" && row.account ? row.account : null };
  if (row.signedIn === false) return { kind: "signed-out" };
  return { kind: "unknown" };
}

/** Whether the create dialog may go ahead with this sign-in state. */
export const ready = (state) => ["signed-in", "unknown", "unsupported"].includes(state?.kind);

/** One sign-in of a harness on a machine, as a small state machine the form
 * renders. The pasted code is passed straight to the machine and never kept
 * in state, logged or echoed back in an error. A second click while a step is
 * pending joins that step; a reply that lands after Cancel is cancelled too. */
export function createLogin(spawn, machine, harness, { onChange, onSignedIn, timeoutMs = LOGIN_TIMEOUT_MS } = {}) {
  let state = Object.freeze({ step: "idle" });
  let loginId = null;
  let pending = null;
  let generation = 0;
  let disposed = false;
  const set = (next) => { if (disposed) return; state = Object.freeze(next); onChange?.(state); };
  const message = (error, code) => {
    let text = String(error?.message ?? error);
    if (code) text = text.split(code).join("…");
    return text;
  };
  const cancelRemote = (id) => (id
    ? ask(spawn, machine, { op: "login.cancel", loginId: id }, { timeoutMs }).then(() => {}, () => {})
    : Promise.resolve());
  const track = (promise) => {
    const tracked = promise.finally(() => { if (pending === tracked) pending = null; });
    pending = tracked;
    return tracked;
  };
  /** Asks for a new sign-in and shows its link; a reply for a cancelled or
   * replaced attempt is cancelled on the machine instead. */
  const open = (mine, extra = {}) => ask(spawn, machine, { op: "login.start", harness }, { timeoutMs })
    .then((reply) => {
      const id = typeof reply.loginId === "string" ? reply.loginId : null;
      if (disposed || mine !== generation) return cancelRemote(id);
      const url = typeof reply.url === "string" && /^https:\/\//.test(reply.url) ? reply.url : null;
      if (!url || !id) {
        void cancelRemote(id);
        throw new Error("The machine did not return a sign-in link.");
      }
      loginId = id;
      set({ step: "waiting", url, needsCode: reply.needsCode !== false, ...extra });
    });
  return {
    get state() { return state; },
    start() {
      if (pending) return pending;
      if (state.step === "waiting") return Promise.resolve();
      const mine = ++generation;
      set({ step: "starting" });
      return track(open(mine).catch((error) => { if (mine === generation) set({ step: "idle", error: message(error) }); }));
    },
    finish(code) {
      const pasted = typeof code === "string" ? code.trim() : "";
      if (pending) return pending;
      if (state.step !== "waiting" || !loginId) return Promise.resolve();
      if (state.needsCode && !pasted) { set({ ...state, error: "Paste the code first." }); return Promise.resolve(); }
      const mine = ++generation;
      const used = loginId;
      set({ step: "finishing", url: state.url, needsCode: state.needsCode, ...(state.renewed ? { renewed: true } : {}) });
      return track(ask(spawn, machine, { op: "login.finish", loginId: used, ...(pasted ? { code: pasted } : {}) }, { timeoutMs })
        .then(async (reply) => {
          if (reply.signedIn === false) throw new Error("Sign-in did not finish.");
          if (loginId === used) loginId = null;
          if (mine !== generation) return;
          set({ step: "done", account: typeof reply.account === "string" ? reply.account : null });
          await onSignedIn?.();
          if (mine === generation) set({ step: "idle" });
        }, async (error) => {
          // A failed finish closes that sign-in on the machine: its link and
          // id are dead. Start one fresh sign-in (once, no loop) for a new link.
          if (loginId === used) loginId = null;
          if (mine !== generation) return;
          const reason = message(error, pasted);
          set({ step: "renewing", error: reason });
          try {
            await open(mine, { renewed: true, error: `${reason} Open the new link and paste its code.` });
          } catch (failure) {
            if (mine === generation) set({ step: "idle", error: `${reason} ${message(failure)}` });
          }
        }));
    },
    cancel() {
      generation++;
      const id = loginId;
      loginId = null;
      set({ step: "idle" });
      return cancelRemote(id);
    },
    /** The form went away: cancel a sign-in that is under way. */
    dispose() {
      if (disposed) return Promise.resolve();
      generation++;
      const id = loginId;
      loginId = null;
      disposed = true;
      return cancelRemote(id);
    },
  };
}

/** Which machine holds each agent. A hosted agent's config is gone once Buzz
 * has set it up, so later steps (which carry only the pubkey) find it here:
 * learned at creation, then from each machine's `list`, else the default. */
export function agentDirectory(spawn) {
  const known = new Map(); // pubkey -> { machine, harness?, respondTo? }
  const listeners = new Set();
  let scan = null;
  const notify = () => { for (const listener of [...listeners]) listener(); };
  const remember = (pubkey, row) => {
    if (!pubkey) return;
    known.set(pubkey, { ...(known.get(pubkey) ?? {}), ...row });
    notify();
  };
  const refresh = () => {
    scan ??= Promise.all(MACHINES.map((machine) =>
      ask(spawn, machine, { op: "list" }, { timeoutMs: STATUS_TIMEOUT_MS })
        .then((reply) => {
          for (const row of reply.agents ?? []) {
            if (row?.pubkey) known.set(row.pubkey, { machine: machine.id, harness: row.harness, respondTo: row.respondTo });
          }
        })
        .catch(() => {})))
      .then(() => { notify(); })
      .finally(() => { scan = null; });
    return scan;
  };
  return {
    remember,
    peek: (pubkey) => known.get(pubkey),
    refresh,
    /** The machine holding `pubkey`. With one machine there is nothing to find. */
    async machine(pubkey) {
      if (known.has(pubkey)) return machineOf(known.get(pubkey).machine);
      if (MACHINES.length > 1) await refresh();
      return machineOf(known.get(pubkey)?.machine);
    },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  };
}

/** One short line under the agent's name: "Claude Code · Commerce Mac". */
export function summaryOf(agent, directory) {
  const seen = directory?.peek?.(agent?.pubkey);
  const machine = machineOf(agent?.config?.machine ?? seen?.machine);
  const harness = harnessLabel(agent?.config?.harness ?? seen?.harness);
  return harness ? `${harness} · ${machine.label}` : machine.label;
}

/** The hosted steps Buzz calls, in terms of `ask`. Each is safe to repeat.
 * Creation goes to the machine the config names; later steps go to the
 * machine the directory says holds the agent. */
export function provider(spawn, requestId = () => crypto.randomUUID(), directory = agentDirectory(spawn)) {
  const pending = new Map(); // name -> request id, so a retried creation gets the same agent
  const clean = (config) => {
    const value = { ...defaults(), ...(config && typeof config === "object" ? config : {}) };
    return { ...value, machine: machineOf(value.machine).id };
  };
  return {
    async provision({ name, picture, community, config, signal }) {
      const settled = clean(config);
      if (!pending.has(name)) pending.set(name, requestId());
      const reply = await ask(spawn, settled.machine, {
        op: "provision", name, community, requestId: pending.get(name),
        ...(picture ? { picture } : {}), config: settled,
      }, { signal });
      directory.remember(reply.pubkey, { machine: settled.machine, harness: settled.harness, respondTo: settled.respondTo });
      return { pubkey: reply.pubkey, ...(picture ? { picture } : {}) };
    },
    async activate({ pubkey, name, community, auth, config, signal }) {
      const machine = config === undefined ? await directory.machine(pubkey) : machineOf(clean(config).machine);
      await ask(spawn, machine, {
        op: "activate", pubkey, community, auth: [...auth],
        ...(config === undefined ? {} : { config: clean(config) }),
      }, { signal });
      directory.remember(pubkey, { machine: machine.id });
      pending.delete(name);
    },
    async profile({ pubkey, name, picture, signal }) {
      await ask(spawn, await directory.machine(pubkey), { op: "profile", pubkey, name, picture: picture ?? null }, { signal });
    },
    instructions: {
      async get({ pubkey, signal }) {
        return (await ask(spawn, await directory.machine(pubkey), { op: "instructions.get", pubkey }, { signal })).instructions ?? "";
      },
      async set({ pubkey, instructions, signal }) {
        await ask(spawn, await directory.machine(pubkey), { op: "instructions.set", pubkey, instructions }, { signal });
      },
    },
    async remove({ pubkey, signal }) {
      await ask(spawn, await directory.machine(pubkey), { op: "remove", pubkey }, { signal });
    },
  };
}

export function apply(ctx) {
  const React = ctx.react;
  const h = React.createElement;
  const spawn = ctx.host?.spawn ? (id, options) => ctx.host.spawn(id, options) : undefined;
  const statuses = statusReader(spawn);
  const directory = agentDirectory(spawn);
  const remote = provider(spawn, undefined, directory);

  // Learn each agent's machine and harness once, off the render path, so
  // summaries and later steps have them.
  if (spawn) setTimeout(() => { void directory.refresh(); }, 0);

  const muted = { color: "var(--text-secondary, inherit)", opacity: 0.8 };
  const row = { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" };

  const Select = ({ label, value, options, onChange, disabled }) =>
    h("label", { style: { display: "grid", gap: 4 } }, label,
      h("select", { value, disabled, onChange: (event) => onChange(event.target.value) },
        ...options.map((option) => h("option", { key: option.id, value: option.id }, option.label))));

  /** The machine's status, read in an effect and shared across views. */
  const useStatus = (machineId) => {
    const [status, setStatus] = React.useState(() => statuses.peek(machineId));
    React.useEffect(() => {
      let live = true;
      setStatus(statuses.peek(machineId));
      const off = statuses.subscribe((id) => { if (live && id === machineOf(machineId).id) setStatus(statuses.peek(machineId)); });
      if (spawn) void statuses.read(machineId).then((next) => { if (live) setStatus(next); });
      return () => { live = false; off(); };
    }, [machineId]);
    return status;
  };

  // Buzz's own spinner class (the app ships Tailwind's `animate-spin`).
  const Spinner = () => h("span", { "aria-hidden": true, className: "motion-safe:animate-spin",
    style: { display: "inline-block", width: 12, height: 12, borderRadius: "50%", border: "2px solid currentColor", borderRightColor: "transparent" } });

  /** Sign-in for one harness on one machine: the state, and the flow. */
  const SignIn = ({ machineId, harness, status, disabled }) => {
    const machine = machineOf(machineId);
    const state = signInState(status, harness);
    const [login, setLogin] = React.useState({ step: "idle" });
    const [code, setCode] = React.useState("");
    const [copied, setCopied] = React.useState(false);
    const flow = React.useRef(null);
    React.useEffect(() => {
      const current = createLogin(spawn, machine.id, harness, {
        onChange: setLogin,
        onSignedIn: () => statuses.read(machine.id, { force: true }),
      });
      flow.current = current;
      setLogin(current.state);
      setCode("");
      return () => { if (flow.current === current) flow.current = null; void current.dispose(); };
    }, [machine.id, harness]);

    const label = harnessLabel(harness) ?? harness;
    if (state.kind === "loading") return h("div", { role: "status", style: { ...row, ...muted } }, h(Spinner), `Checking ${machine.label}…`);
    if (state.kind === "unreachable") return h("div", { role: "alert", style: { display: "grid", gap: 6 } },
      h("span", null, state.error || `Could not reach the ${machine.label}.`),
      h("div", null, h("button", { type: "button", disabled, onClick: () => void statuses.read(machine.id, { force: true }) }, "Try again")));
    if (state.kind === "unsupported") return h("div", { style: muted }, `The ${machine.label} cannot report sign-in yet.`);
    if (state.kind === "not-installed") return h("div", { role: "alert" }, `${label} is not installed on the ${machine.label}.`);
    if (state.kind === "signed-in" && !["waiting", "finishing", "renewing"].includes(login.step)) return h("div", { style: row },
      h("span", null, state.account ? `Signed in as ${state.account}` : `${label} is signed in`));
    if (state.kind === "unknown" && login.step === "idle") return h("div", { style: { display: "grid", gap: 6 } },
      h("div", { style: { ...row, ...muted } },
        h("span", null, "Sign-in status unknown"),
        h("button", { type: "button", disabled, onClick: () => void flow.current?.start() }, "Sign in")),
      login.error && h("span", { role: "alert" }, login.error));

    // Not signed in, or a sign-in under way.
    const busy = login.step === "starting" || login.step === "finishing" || login.step === "renewing";
    if (login.step === "renewing") return h("div", { style: { display: "grid", gap: 6 } },
      h("span", { role: "alert" }, login.error),
      h("div", { role: "status", style: { ...row, ...muted } }, h(Spinner), "Getting a new link…"));
    if (login.step === "idle" || login.step === "starting" || login.step === "done") return h("div", { style: { display: "grid", gap: 6 } },
      h("div", { style: row },
        h("span", null, login.step === "done" ? "Signed in. Checking…" : `${label} is not signed in`),
        login.step !== "done" && h("button", { type: "button", disabled: disabled || busy, "aria-busy": busy, onClick: () => void flow.current?.start() },
          busy ? h(Spinner) : "Sign in"),
        login.step === "starting" && h("button", { type: "button", onClick: () => void flow.current?.cancel() }, "Cancel")),
      login.error && h("span", { role: "alert" }, login.error));

    const submit = () => {
      const pasted = code;
      setCode("");
      void flow.current?.finish(pasted);
    };
    return h("div", { style: { display: "grid", gap: 8 } },
      h("div", { style: row },
        h("a", { href: login.url, target: "_blank", rel: "noopener noreferrer" }, login.renewed ? `Open new ${label} sign-in` : `Open ${label} sign-in`),
        h("button", { type: "button", onClick: () => {
          Promise.resolve(globalThis.navigator?.clipboard?.writeText?.(login.url))
            .then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }, () => {});
        } }, copied ? "Copied" : "Copy link")),
      login.needsCode
        ? h("form", { style: row, onSubmit: (event) => { event.preventDefault(); submit(); } },
          h("input", { type: "password", autoComplete: "off", spellCheck: false, placeholder: "Paste code", "aria-label": "Sign-in code",
            value: code, disabled: busy, onChange: (event) => setCode(event.target.value), style: { flex: 1, minWidth: 160 } }),
          h("button", { type: "submit", disabled: busy || !code.trim(), "aria-busy": busy }, busy ? h(Spinner) : "Finish"),
          h("button", { type: "button", onClick: () => { setCode(""); void flow.current?.cancel(); } }, "Cancel"))
        : h("div", { style: row },
          h("button", { type: "button", disabled: busy, "aria-busy": busy, onClick: submit }, busy ? h(Spinner) : "Done"),
          h("button", { type: "button", onClick: () => void flow.current?.cancel() }, "Cancel")),
      login.error && h("span", { role: "alert" }, login.error));
  };

  const Configuration = ({ config, onChange, disabled, harnessControl, onReadyChange }) => {
    const value = { ...defaults(), ...(config ?? {}) };
    const machine = machineOf(value.machine);
    const status = useStatus(machine.id);
    const options = harnessOptions(status);
    const offered = options.length ? options : HARNESSES;
    const state = spawn ? signInState(status, value.harness) : { kind: "unreachable" };

    // A harness the machine does not have: suggest the first one it does.
    React.useEffect(() => {
      if (status?.kind === "ok" && options.length && !options.some((entry) => entry.id === value.harness))
        onChange({ ...value, harness: options[0].id }, { suggested: true });
    }, [status, value.harness]);
    const isReady = ready(state) && (status?.kind !== "ok" || options.some((entry) => entry.id === value.harness));
    React.useEffect(() => { onReadyChange?.(isReady); }, [onReadyChange, isReady]);
    React.useEffect(() => () => onReadyChange?.(false), [onReadyChange]);

    return h("div", { style: { display: "grid", gap: 12 } },
      harnessControl,
      h(Select, { label: "Runs on", value: machine.id, options: MACHINES, disabled, onChange: (id) => onChange({ ...value, machine: id }) }),
      h(Select, { label: "Runs", value: value.harness, options: status?.kind === "ok" && !options.length ? [] : offered, disabled: disabled || (status?.kind === "ok" && !options.length),
        onChange: (harness) => onChange({ ...value, harness }) }),
      status?.kind === "ok" && !options.length && h("span", { role: "alert" }, `No harness is installed on the ${machine.label}.`),
      h(Select, { label: "Answers", value: value.respondTo, options: ANSWERS, disabled, onChange: (respondTo) => onChange({ ...value, respondTo }) }),
      spawn
        ? h(SignIn, { machineId: machine.id, harness: value.harness, status, disabled })
        : h("p", { role: "alert" }, "This Buzz cannot start processes, so it cannot reach Black 4 hardware."));
  };

  const Create = ({ config, onChange, disabled }) => {
    const value = { ...defaults(), ...(config ?? {}) };
    return h("label", { style: { display: "grid", gap: 4 } }, "Instructions",
      h("textarea", { rows: 6, maxLength: 20000, value: value.instructions, disabled,
        onChange: (event) => onChange({ ...value, instructions: event.target.value }) }));
  };

  /** One labelled line of the Settings tab. */
  const Line = ({ title, children }) => h("div", { style: { display: "grid", gridTemplateColumns: "8rem 1fr", gap: 8, alignItems: "baseline" } },
    h("span", { style: muted }, title), h("div", null, children));

  const Settings = ({ agent, settingsHost, settingsContent }) => {
    const pubkey = agent.pubkey;
    const [seen, setSeen] = React.useState(() => directory.peek(pubkey));
    const [machineId, setMachineId] = React.useState(() => machineOf(seen?.machine).id);
    const [run, setRun] = React.useState({ loading: true });
    const [restarting, setRestarting] = React.useState(false);
    const [text, setText] = React.useState({ loading: true, base: "", draft: "" });
    const [saving, setSaving] = React.useState(false);
    const [revision, setRevision] = React.useState(0);

    React.useEffect(() => directory.subscribe(() => setSeen(directory.peek(pubkey))), [pubkey]);
    React.useEffect(() => {
      const controller = new AbortController();
      const { signal } = controller;
      setRun((prior) => ({ ...prior, loading: true, error: undefined }));
      void (async () => {
        const machine = await directory.machine(pubkey);
        if (signal.aborted) return;
        setMachineId(machine.id);
        const [status, instructions] = await Promise.allSettled([
          ask(spawn, machine, { op: "status", pubkey }, { signal, timeoutMs: STATUS_TIMEOUT_MS }),
          remote.instructions.get({ pubkey, signal }),
        ]);
        if (signal.aborted) return;
        if (status.status === "fulfilled") {
          const reply = status.value;
          directory.remember(pubkey, { machine: machine.id, harness: reply.harness, respondTo: reply.respondTo });
          setRun({ loading: false, running: !!reply.running, activated: !!reply.activated, harness: reply.harness, respondTo: reply.respondTo });
        } else setRun({ loading: false, error: String(status.reason?.message ?? status.reason) });
        if (instructions.status === "fulfilled") setText({ loading: false, base: instructions.value, draft: instructions.value });
        else setText({ loading: false, base: "", draft: "", error: String(instructions.reason?.message ?? instructions.reason) });
      })().catch((error) => { if (!signal.aborted) setRun({ loading: false, error: String(error?.message ?? error) }); });
      return () => controller.abort();
    }, [pubkey, revision]);

    const machine = machineOf(machineId);
    const harness = run.harness ?? seen?.harness;
    const respondTo = run.respondTo ?? seen?.respondTo;
    const status = useStatus(machine.id);

    const restart = async () => {
      if (restarting) return;
      setRestarting(true);
      try {
        await ask(spawn, machine, { op: "start", pubkey });
        setRevision((value) => value + 1);
      } catch (error) {
        setRun((prior) => ({ ...prior, error: String(error?.message ?? error) }));
      } finally { setRestarting(false); }
    };
    const save = async () => {
      if (saving) return;
      setSaving(true);
      try {
        // Read again first, so an edit saved elsewhere is not overwritten.
        const latest = await remote.instructions.get({ pubkey });
        if (latest !== text.base) {
          setText({ loading: false, base: latest, draft: text.draft, error: "Its instructions were changed elsewhere. Check the latest, then save again." });
          return;
        }
        await remote.instructions.set({ pubkey, instructions: text.draft });
        setText({ loading: false, base: text.draft, draft: text.draft });
      } catch (error) {
        setText((prior) => ({ ...prior, error: String(error?.message ?? error) }));
      } finally { setSaving(false); }
    };

    const running = run.loading ? h("span", { style: { ...row, ...muted } }, h(Spinner), "Checking…")
      : run.error ? h("span", { role: "alert" }, run.error)
        : h("span", null, run.running ? "Running" : run.activated === false ? "Not set up" : "Stopped");
    const dirty = text.draft !== text.base;
    return h("div", { style: { display: "grid", gap: 16 } },
      settingsHost?.typeControl?.(false),
      h("div", { style: { display: "grid", gap: 10 } },
        h(Line, { title: "Runs on" }, machine.label),
        h(Line, { title: "Runs" }, harnessLabel(harness) ?? (run.loading ? "…" : "Unknown")),
        h(Line, { title: "Answers" }, ANSWERS.find((entry) => entry.id === respondTo)?.label ?? (run.loading ? "…" : "Unknown")),
        h(Line, { title: "Status" }, h("div", { style: row }, running,
          h("button", { type: "button", disabled: restarting || run.loading, "aria-busy": restarting, onClick: () => void restart() }, restarting ? h(Spinner) : "Restart"))),
        harness && h(Line, { title: "Sign-in" }, h(SignIn, { machineId: machine.id, harness, status, disabled: false }))),
      h("label", { style: { display: "grid", gap: 4 } }, "Instructions",
        h("textarea", { rows: 8, maxLength: 20000, value: text.draft, disabled: text.loading || saving,
          placeholder: text.loading ? "Loading…" : "", onChange: (event) => setText({ ...text, draft: event.target.value, error: undefined }) })),
      (dirty || text.error) && h("div", { style: row },
        dirty && h("button", { type: "button", disabled: saving, "aria-busy": saving, onClick: () => void save() }, saving ? h(Spinner) : "Save"),
        dirty && h("button", { type: "button", disabled: saving, onClick: () => setText({ ...text, draft: text.base, error: undefined }) }, "Discard"),
        text.error && h("span", { role: "alert" }, text.error)),
      settingsContent);
  };

  ctx.agents.register({
    id: "hardware",
    title: "Black 4 hardware",
    description: "Runs on a Black 4 machine, not this computer.",
    defaults: () => ({ config: defaults() }),
    adopt: (carry, saved) => ({ ...saved, instructions: carry.instructions ?? saved.instructions }),
    summary: (agent) => summaryOf(agent, directory),
    Create,
    CreateConfiguration: Configuration,
    tabs: [{ id: "settings", title: "Settings", role: "settings", component: Settings }],
    remote,
  });
}
