// @vitest-environment jsdom
// Black 4 canary, part 2: actually start Black 4's plugins in a Buzz checkout.
// canary/load.mjs copies this file and the three plugin.js files into
// <buzz-app>/src/__black4_canary__/ and runs it with Buzz's own vitest, so
// everything below is Buzz's real code: createServices() is the composition
// the app itself runs, and each plugin starts the way src/plugins/runtime.ts
// starts one (a scope with pluginOwner, then ctx.plugin with inject/apply).
// Then every component the plugins register is rendered once on the server
// with the props Buzz gives it, so a prop or service change that throws at
// render shows up too. Nothing here reaches a network or a machine: off the
// desktop, host.spawn and host.request reject, and the plugins handle that
// as "unreachable" (the Black 4 plugin simply stays signed out).
// The Black 4 plugin offers its hosted "Black 4 hardware" type only to a staff
// sign-in, which never happens here, so two more tests start that part on its
// own through the plugin's exported hardwareSlot: once to register, render and
// withdraw it, and once with Buzz's agents.register made to throw, to prove the
// rest of the plugin starts anyway and the failure is reported.
import { afterAll, expect, test, vi } from "vitest";
import { createElement, type ComponentType } from "react";
import { renderToString } from "react-dom/server";
import { createServices } from "../app/services";
import { AgentsService } from "../features/agents/service";
import { SettingsCardsService } from "../features/settings/service";
import { PagesService } from "../features/pages/service";
import { PanelsService } from "../features/panels/service";
import plugins from "./plugins.json";

type Registered = { plugin: string; kind: string; value: Record<string, unknown> };
const registered: Registered[] = [];
let current = "";
let refuseHardware = false; // makes agents.register throw for the hardware type
const record = (kind: string, target: { prototype: Record<string, unknown> }, method = "register") => {
  const original = target.prototype[method] as (...args: unknown[]) => unknown;
  vi.spyOn(target.prototype as never, method as never).mockImplementation(function (this: unknown, ...args: unknown[]) {
    const value = args[0] as Record<string, unknown>;
    if (refuseHardware && kind === "agent type" && value?.id === "hardware") throw new Error("canary refused the hardware type");
    if (current) registered.push({ plugin: current, kind, value });
    return original.apply(this, args);
  } as never);
};
record("agent type", AgentsService as never);
record("settings card", SettingsCardsService as never);
record("page", PagesService as never);
record("panel", PanelsService as never);

const services = createServices();
// The services' root context: every service keeps the one it was made with.
const root = (services.agents as unknown as { ctx: { extend(value: object): any; root?: unknown } }).ctx;
const fibers: { dispose(): unknown }[] = [];

afterAll(async () => {
  for (const fiber of fibers) await Promise.resolve(fiber.dispose()).catch(() => {});
  await Promise.resolve(services.dispose()).catch(() => {});
});

const until = async (done: () => boolean, ms = 10_000) => {
  const deadline = Date.now() + ms;
  while (!done() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
};
const ACTIVE = 2; // cordis FiberState.active, as src/plugins/runtime.ts names it
const FAILED = 3;

for (const plugin of plugins as { id: string; title: string; file: string }[]) {
  test(`${plugin.title} (${plugin.id}) starts in this Buzz`, async () => {
    const module = await import(/* @vite-ignore */ `./${plugin.file}`);
    expect(typeof module.apply, "plugin.js exports apply").toBe("function");
    current = plugin.id;
    const scope = root.extend({ pluginOwner: Object.freeze({ id: plugin.id, revision: "canary", agentHooks: [], agentExecution: [] }) });
    const fiber = scope.plugin({ name: plugin.id, inject: module.inject ?? [], apply: (ctx: unknown) => module.apply(ctx) });
    fibers.push(fiber);
    const deadline = Date.now() + 10_000;
    while (fiber.state !== ACTIVE && fiber.state !== FAILED && Date.now() < deadline) await new Promise((done) => setTimeout(done, 20));
    // Parts started in their own child scope (Black 4's Reviews) register a moment later.
    const pages = () => registered.filter((entry) => entry.plugin === plugin.id && (entry.kind === "page" || entry.kind === "panel")).length;
    if (fiber.state === ACTIVE && typeof module.reviewsSlot === "function") await until(() => pages() >= 2, 5_000);
    current = "";
    if (fiber.state === FAILED) {
      const reason = await fiber.await().then(() => "unknown", (error: unknown) => String((error as Error)?.message ?? error));
      throw new Error(`${plugin.title} threw while starting: ${reason}`);
    }
    expect(fiber.state, `${plugin.title} did not become active in 10 s (a service it injects is missing?)`).toBe(ACTIVE);
    expect(registered.some((entry) => entry.plugin === plugin.id), `${plugin.title} registered nothing`).toBe(true);
  });
}

const owner = (id: string) => Object.freeze({ id, revision: "canary", agentHooks: [], agentExecution: [] });
const hardwarePlugins: { id: string; title: string; module: any }[] = [];
for (const plugin of plugins as { id: string; title: string; file: string }[]) {
  const module = await import(/* @vite-ignore */ `./${plugin.file}`);
  if (typeof module.hardwareSlot === "function") hardwarePlugins.push({ id: plugin.id, title: plugin.title, module });
}

for (const { id, title, module } of hardwarePlugins) {
  test(`${title}: Black 4 hardware registers in its own scope, and withdraws so it can be offered again`, async () => {
    const errors: unknown[] = [];
    const access = { use: () => ({ status: "unlinked" }), link: () => {} };
    let slot: { offer(): void; withdraw(): void; offered: boolean } | undefined;
    current = id;
    const fiber = root.extend({ pluginOwner: owner(`${id}.hardware-canary`) }).plugin({
      name: `${id}.hardware-canary`, inject: ["react", "host", "agents"],
      apply: (ctx: unknown) => { slot = module.hardwareSlot(ctx, { report: (error: unknown) => errors.push(error), access }); slot!.offer(); },
    });
    fibers.push(fiber);
    const count = () => registered.filter((entry) => entry.plugin === id && entry.value.id === "hardware").length;
    await until(() => count() === 1 || errors.length > 0);
    expect(errors.map(String), "registering the hardware type").toEqual([]);
    expect(count(), "the hardware type was registered").toBe(1);
    slot!.withdraw();
    await new Promise((resolve) => setTimeout(resolve, 50));
    // Buzz refuses a second registration of the same key, so this only works
    // when withdrawing really removed the first.
    slot!.offer();
    await until(() => count() === 2 || errors.length > 0);
    current = "";
    expect(errors.map(String), "offering the hardware type again after withdrawing it").toEqual([]);
    expect(count()).toBe(2);
    expect(slot!.offered).toBe(true);
  });

  test(`${title}: when Buzz refuses the hardware type, the rest of the plugin starts and the failure is reported`, async () => {
    const errors: unknown[] = [];
    const name = `${id}.isolation-canary`;
    refuseHardware = true;
    current = name;
    const fiber = root.extend({ pluginOwner: owner(name) }).plugin({
      name, inject: module.inject ?? [],
      apply: (ctx: unknown) => {
        module.apply(ctx);
        module.hardwareSlot(ctx, { report: (error: unknown) => errors.push(error), access: { use: () => ({ status: "idle" }), link: () => {} } }).offer();
      },
    });
    fibers.push(fiber);
    await until(() => (fiber.state === ACTIVE && errors.length > 0 && registered.filter((entry) => entry.plugin === name && entry.kind === "panel").length > 0) || fiber.state === FAILED);
    refuseHardware = false;
    current = "";
    expect(fiber.state, "the plugin stays active").toBe(ACTIVE);
    expect(errors.map((error) => String((error as Error)?.message ?? error))).toEqual(["canary refused the hardware type"]);
    const kinds = registered.filter((entry) => entry.plugin === name).map((entry) => entry.kind);
    for (const kind of ["settings card", "page", "panel"]) expect(kinds, `it still registered its ${kind}`).toContain(kind);
  });
}

test("every component the plugins register renders", () => {
  const failures: string[] = [];
  const render = (where: string, component: unknown, props: Record<string, unknown>) => {
    if (typeof component !== "function") return;
    try {
      renderToString(createElement(component as ComponentType<Record<string, unknown>>, props));
    } catch (error) {
      failures.push(`${where} threw while rendering: ${(error as Error)?.message ?? error}`);
    }
  };
  for (const { plugin, kind, value } of registered) {
    const title = (plugins as { id: string; title: string }[]).find((entry) => entry.id === plugin)?.title ?? plugin;
    const where = (part: string) => `${title}: ${kind} "${String(value.id)}" ${part}`;
    if (kind === "agent type") {
      const defaults = (value.defaults as () => { config: unknown })();
      const config = defaults.config;
      const agent = {
        key: `${"e".repeat(64)}@wss://relay.example.test`, pubkey: "e".repeat(64), name: "Canary", type: `${plugin}/${String(value.id)}`,
        owner: "a".repeat(64), relay: "wss://relay.example.test", place: value.remote ? "hosted" : "here",
        attention: {}, skipped: {}, timers: {}, attentionEnabled: false, config,
      };
      const create = { config, onChange: () => {}, disabled: false, onReadyChange: () => {}, harnessControl: null };
      for (const part of ["Create", "CreateConfiguration", "CreateModel", "CreateThinking"]) render(where(part), value[part], create);
      for (const tab of (value.tabs as { id: string; component: unknown }[] | undefined) ?? []) {
        render(where(`tab "${tab.id}"`), tab.component, {
          agent, save: async () => {}, settingsHost: { typeControl: () => null }, settingsContent: null,
        });
      }
      if (typeof value.summary === "function") {
        try { (value.summary as (a: unknown) => string)(agent); } catch (error) { failures.push(`${where("summary")} threw: ${(error as Error)?.message ?? error}`); }
      }
    } else if (kind === "settings card") {
      render(where("component"), value.component, {});
    } else if (kind === "page") {
      render(where("component"), value.component, {});
      render(where("badge"), value.badge, {});
    } else if (kind === "panel") {
      render(where("component"), value.component, { target: "https://app.black4.ai/reviews" });
      render(where("channel launcher"), value.channelLauncher, { available: () => true, toggle: () => {}, pressed: false });
    }
  }
  expect(failures, failures.join("\n")).toEqual([]);
});
