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
// carries it.

export const inject = ["react", "host", "agents"];

const MACHINE = "commerce";
const TIMEOUT_MS = 45 * 1000;
const HARNESSES = [
  { id: "claude", label: "Claude Code" },
  { id: "codex", label: "Codex" },
  { id: "grok", label: "Grok Build" },
  { id: "goose", label: "Goose" },
];
const ANSWERS = [
  { id: "anyone", label: "Everyone in the community" },
  { id: "owner-only", label: "Only me" },
];

export const defaults = () => ({ harness: "claude", model: "", respondTo: "anyone", instructions: "" });

/** One request to a machine's agentctl: JSON in on stdin, one JSON reply out.
 * `spawn` is `ctx.host.spawn`. Rejects with the machine's own error text. */
export async function ask(spawn, request, { signal, timeoutMs = TIMEOUT_MS } = {}) {
  if (typeof spawn !== "function") throw new Error("This Buzz cannot start processes, so it cannot reach Black 4 hardware.");
  let out = "";
  let err = "";
  const text = (chunk) => (typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
  const child = await spawn(MACHINE, {
    onStdout: (chunk) => { out += text(chunk); },
    onStderr: (chunk) => { err += text(chunk); },
  });
  const stop = () => { try { Promise.resolve(child.kill?.()).catch(() => {}); } catch {} };
  const timer = setTimeout(stop, timeoutMs);
  signal?.addEventListener?.("abort", stop, { once: true });
  try {
    await child.write(JSON.stringify(request));
    await child.end?.();
    await child.exited;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener?.("abort", stop);
  }
  if (signal?.aborted) throw new DOMException("Cancelled.", "AbortError");
  let reply;
  try { reply = JSON.parse(out.trim().split("\n").pop() || ""); } catch {
    throw new Error(`Could not reach the ${MACHINE} machine${err.trim() ? `: ${err.trim().slice(-300)}` : "."}`);
  }
  if (!reply?.ok) throw new Error(reply?.error || "The machine refused the request.");
  return reply;
}

/** The hosted steps Buzz calls, in terms of `ask`. Each is safe to repeat. */
export function provider(spawn, requestId = () => crypto.randomUUID()) {
  const pending = new Map(); // name -> request id, so a retried creation gets the same agent
  const clean = (config) => ({ ...defaults(), ...(config && typeof config === "object" ? config : {}) });
  return {
    async provision({ name, picture, community, config, signal }) {
      if (!pending.has(name)) pending.set(name, requestId());
      const reply = await ask(spawn, {
        op: "provision", name, community, requestId: pending.get(name),
        ...(picture ? { picture } : {}), config: clean(config),
      }, { signal });
      return { pubkey: reply.pubkey, ...(picture ? { picture } : {}) };
    },
    async activate({ pubkey, name, community, auth, config, signal }) {
      await ask(spawn, {
        op: "activate", pubkey, community, auth: [...auth],
        ...(config === undefined ? {} : { config: clean(config) }),
      }, { signal });
      pending.delete(name);
    },
    async profile({ pubkey, name, picture, signal }) {
      await ask(spawn, { op: "profile", pubkey, name, picture: picture ?? null }, { signal });
    },
    instructions: {
      async get({ pubkey, signal }) {
        return (await ask(spawn, { op: "instructions.get", pubkey }, { signal })).instructions ?? "";
      },
      async set({ pubkey, instructions, signal }) {
        await ask(spawn, { op: "instructions.set", pubkey, instructions }, { signal });
      },
    },
    async remove({ pubkey, signal }) {
      await ask(spawn, { op: "remove", pubkey }, { signal });
    },
  };
}

export function apply(ctx) {
  const React = ctx.react;
  const h = React.createElement;
  const spawn = ctx.host?.spawn ? (id, options) => ctx.host.spawn(id, options) : undefined;

  const Select = ({ label, value, options, onChange, disabled }) =>
    h("label", { style: { display: "grid", gap: 4 } }, label,
      h("select", { value, disabled, onChange: (event) => onChange(event.target.value) },
        ...options.map((option) => h("option", { key: option.id, value: option.id }, option.label))));

  const Configuration = ({ config, onChange, disabled, harnessControl, onReadyChange }) => {
    const value = { ...defaults(), ...(config ?? {}) };
    React.useEffect(() => { onReadyChange?.(!!spawn); }, [onReadyChange]);
    return h("div", { style: { display: "grid", gap: 12 } },
      harnessControl,
      h(Select, { label: "Runs", value: value.harness, options: HARNESSES, disabled, onChange: (harness) => onChange({ ...value, harness }) }),
      h(Select, { label: "Answers", value: value.respondTo, options: ANSWERS, disabled, onChange: (respondTo) => onChange({ ...value, respondTo }) }),
      h("p", null, `Runs on the Black 4 ${MACHINE} machine, signed in to its own model subscriptions. It keeps working while Buzz is closed.`),
      !spawn && h("p", { role: "alert" }, "This Buzz cannot start processes, so it cannot reach Black 4 hardware."));
  };

  const Create = ({ config, onChange, disabled }) => {
    const value = { ...defaults(), ...(config ?? {}) };
    return h("label", { style: { display: "grid", gap: 4 } }, "Instructions",
      h("textarea", { rows: 6, maxLength: 20000, value: value.instructions, disabled,
        onChange: (event) => onChange({ ...value, instructions: event.target.value }) }));
  };

  ctx.agents.register({
    id: "hardware",
    title: "Black 4 hardware",
    description: "Runs on a Black 4 machine, not this computer.",
    defaults: () => ({ config: defaults() }),
    adopt: (carry, saved) => ({ ...saved, instructions: carry.instructions ?? saved.instructions }),
    summary: (agent) => {
      const harness = HARNESSES.find((entry) => entry.id === agent.config?.harness)?.label ?? "Black 4 hardware";
      return `${harness} · ${MACHINE}`;
    },
    Create,
    CreateConfiguration: Configuration,
    remote: provider(spawn),
  });
}
