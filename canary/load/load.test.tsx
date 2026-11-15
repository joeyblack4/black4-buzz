// @vitest-environment jsdom
// Black 4 canary, part 2: actually start Black 4's plugins in a Buzz checkout.
// canary/load.mjs copies this file and the four plugin.js files into
// <buzz-app>/src/__black4_canary__/ and runs it with Buzz's own vitest, so
// everything below is Buzz's real code: createServices() is the composition
// the app itself runs, and each plugin starts the way src/plugins/runtime.ts
// starts one (a scope with pluginOwner, then ctx.plugin with inject/apply).
// Then every component the plugins register is rendered once on the server
// with the props Buzz gives it, so a prop or service change that throws at
// render shows up too. Nothing here reaches a network or a machine: off the
// desktop, host.spawn rejects and the plugins handle that as "unreachable".
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
const record = (kind: string, target: { prototype: Record<string, unknown> }, method = "register") => {
  const original = target.prototype[method] as (...args: unknown[]) => unknown;
  vi.spyOn(target.prototype as never, method as never).mockImplementation(function (this: unknown, ...args: unknown[]) {
    if (current) registered.push({ plugin: current, kind, value: args[0] as Record<string, unknown> });
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
    current = "";
    if (fiber.state === FAILED) {
      const reason = await fiber.await().then(() => "unknown", (error: unknown) => String((error as Error)?.message ?? error));
      throw new Error(`${plugin.title} threw while starting: ${reason}`);
    }
    expect(fiber.state, `${plugin.title} did not become active in 10 s (a service it injects is missing?)`).toBe(ACTIVE);
    expect(registered.some((entry) => entry.plugin === plugin.id), `${plugin.title} registered nothing`).toBe(true);
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
