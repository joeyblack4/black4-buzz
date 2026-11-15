# Buzz canary

Status: current  
Owner: Black 4 platform  
Updated: 2026-11-14

Tells us whether a new Buzz breaks a Black 4 plugin, before anyone clicks
**Update** in Buzz. The [buzz-canary workflow](../.github/workflows/buzz-canary.yml)
runs every day, and on demand, against three versions of
[block/buzz-app](https://github.com/block/buzz-app): the latest release, the
newest preview and `main`. It also runs on pull requests that touch `plugins/`
or `canary/`.

## What is checked

1. **The contract** (`check.mjs`, about 1 second). [`contract.json`](contract.json)
   lists, for each of the three plugins, every Buzz API it relies on: the
   services it injects, each `ctx.*` call, the fields it reads from what Buzz
   passes it (delivery, create and settings props, hosted-agent inputs), the
   keys of every object it hands to Buzz (agent types, the `remote` provider,
   tabs, pages, panels, settings cards, tools), the literal values it passes
   (`role: "settings"`, `placement: "dock"`), and every manifest key.
   `check.mjs` reads Buzz's own TypeScript types with the TypeScript compiler
   and Buzz's Rust manifest schema (`crates/plugin-manager`, which refuses
   unknown keys), and fails with one sentence per problem, for example:
   > Black 4 (MCP bridge, Reviews, Agent access, Black 4 hardware) (ai.black4): it gives Buzz ctx.agents.register(…).remote with "provision", "activate", "profile", "instructions", "remove", but Buzz v1.0.4 now also requires "restart", which the plugin does not give.

   It also fails when Buzz moves to another version of cordis or React, the
   libraries the plugin envelope is typed with.
2. **The load** (`load.mjs`, about 20 seconds including installing Buzz's
   JavaScript dependencies). It builds Buzz's real app services
   (`createServices()`, what the app runs), starts each plugin the way Buzz's
   plugin runtime does, requires each one to become active, and renders every
   component it registers once. This catches what types cannot show: a plugin
   that throws at start, or a Buzz check that refuses a registration at run
   time (for example "a hosted agent type has no run, models or timeoutMs").
   Black 4 hardware is offered only to a staff sign-in, which the canary never
   has, so it also starts that part on its own: it must register in its own
   scope, render, withdraw and register again; and with Buzz's
   `agents.register` made to throw, the rest of the Black 4 plugin must still
   start (settings card, Reviews page and panel) and the failure be reported.
3. **The machine pairing** (`scripts/check-machine-pins.mjs`, in `npm run check`).
   [`machine/pins.json`](../machine/pins.json) declares the buzz-acp harness
   release and the ACP adapter and SDK versions that must go together. The
   check fails when `machine/setup.sh`, its comments or the machine tests
   disagree with it.
4. **The contract stays complete** (`tests/canary-contract.test.mjs`, in
   `npm test`). It fails when a plugin starts using a `ctx` API the contract
   does not list, or when a plugin's `inject` list changes.

Proven on 2026-11-14: both parts pass against v1.0.2 (the Buzz.app installed
here), v1.0.3-preview.2 and `main`. The contract part failed with 14 plain
sentences against a copy of v1.0.2 with five deliberate changes (a renamed
process field, a renamed create prop, a new required hosted-agent step, a
narrowed tab role, a removed manifest key). The load part failed against a
copy whose agent registration refuses hosted types with `instructions`, a
change the contract part could not see.

## What is not checked

- **Behaviour.** That Buzz still calls `provision`, then `activate`, still
  delivers mentions to `run`, still shows the settings tab where people expect
  it, or still sends the same values. The canary checks shapes and startup,
  not what Buzz does with the plugin afterwards.
- **The desktop app itself.** It reads Buzz's source at a tag, not the signed
  Buzz.app that update installs; the two come from the same tag. Native-only
  paths (`host.spawn`, `host.serveMcp`, `host.readFile` really starting a
  process or server) are only checked by their types: off the desktop they
  reject, and the load test lets them.
- **Rendering after effects.** Components render once on the server, so code
  inside `useEffect`, clicks and live updates do not run.
- **Loosely typed values.** Where Buzz types something as `unknown` (an
  agent's `config`, a relay event), nothing beneath it is checked. `check.mjs`
  lists any such path it could not verify.
- **The agent machines.** buzz-acp comes from block/buzz, not block/buzz-app,
  and is vendored by hand. The canary only checks that our own pins agree
  with each other; it does not watch block/buzz releases or test the ACP
  handshake.
- **Anything a plugin does not declare in `contract.json`.** The completeness
  test reads `ctx.a.b` uses; deeper reads are only checked if listed.

## When it goes red

1. Open the failed run. Each failing job is one Buzz version: "release" means
   the Buzz that Update installs now, "preview" and "main" mean a change that
   is coming.
2. **Release red: do not update Buzz** on any computer that runs these plugins
   until the plugin is fixed.
3. Read the sentences. Each names the plugin, the API and what changed. Find
   the change in [block/buzz-app](https://github.com/block/buzz-app) (its
   `src/features/agents/service.ts`, `src/features/host/service.ts`,
   `src/plugins/api.ts` and `crates/plugin-manager/src/lib.rs` are where most
   of the contract lives) and fix the plugin under `plugins/`.
4. Update `contract.json` to match what the fixed plugin uses, and run locally:
   ```bash
   npm ci --prefix canary
   node canary/check.mjs ~/src/buzz-app --label main
   ```
   For the load part, install the checkout's dependencies first (`pnpm install
   --frozen-lockfile --ignore-scripts` in it), then `node canary/load.mjs <checkout>`.
5. If the canary itself is wrong (Buzz moved a file, the check misreads a
   type), fix the canary, not the contract.

## Updating the contract

Whenever a plugin starts or stops using a Buzz API, change `contract.json` in
the same commit; `npm test` fails until you do. Path syntax: `.name` is a
property, `(n)` is the n-th argument of a call, `=>` is what a call returns
(a promise is unwrapped), `[]` is a list element. `uses` must exist,
`provides` are the keys of an object we give Buzz, `accepts` are literal
values we pass. When Buzz moves cordis or React, bump `envelope` in
`contract.json` and `canary/package.json` together.
