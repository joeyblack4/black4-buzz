# Testing a plugin change without production

Status: current  
Owner: Black 4 platform  
Updated: 2026-11-17

How to see a change working before it reaches the people on `stable`. Each
layer below catches what the one before cannot. Facts about Buzz are from
Buzz v1.0.5's source (`~/src/buzz-app`, `git show v1.0.5:<path>`).

| Layer | What it proves | What it cannot |
| --- | --- | --- |
| `npm run check` | The plugin parses, folders hold only what Buzz reads, built copies match their source, unit tests over fake AuthKit, MCP and door servers (`tests/fakes.mjs`). | Anything Buzz does. |
| CI `canary` job | Buzz's own types and manifest schema accept each plugin, and Buzz's real services activate it and render every component, against the Buzz release Update installs now ([canary/README.md](../canary/README.md)). | Behaviour after start, native calls, live data. |
| CI `gates` job | What the change does to people: stale builds, new host access, a changed agent tool list, which plugins will offer an update. | Tools the Black 4 MCP itself changes. |
| Your isolated Buzz profile | The real app, your real sign-in, live MCP, screens next to Buzz's own. | The Git update path, other people's Macs. |
| `preview` channel | Real installs that update from Git within the hour, like everyone's. | Nothing more is needed before `stable`. |

## 1. The local loop, in a Buzz profile of its own

Never point your everyday Buzz at a working copy. Installing a folder over
the plugin you installed from Git replaces its saved source: that copy stops
checking for updates and keeps whatever you last loaded (the trap where an
install "stays up to date" forever). Use a second profile instead.

**The packaged app cannot give you one while it runs.** Buzz.app takes a
single-instance lock (`tauri-plugin-single-instance`,
`src-tauri/src/lib.rs`), so `BUZZODZ_PROFILE=… open -n /Applications/Buzz.app`
hands over to the Buzz already running, in your real profile. A development
build of Buzz does not take that lock and keeps its data in its own folder
(`xyz.block.buzz.desktop.dev`), so it runs beside your everyday Buzz
(`docs/contributing.md`). It needs Rust, pnpm and `just`, as buzz-app's
`docs/contributing.md` describes.

Use a worktree of your own, so a checkout other sessions read never moves:

```bash
git -C ~/src/buzz-app worktree add ~/src/buzz-app-black4-test v1.0.5
```

```bash
cd ~/src/buzz-app-black4-test && BUZZODZ_PROFILE=black4-test bin/just desktop
```

Use `main` in place of `v1.0.5` to look ahead at the next Buzz.

In that window:

1. **Install the folder with Browse.** Settings → Plugins → Manage plugins →
   Add → **Browse** under Add from folder → pick `plugins/black4` in your
   worktree → review the access → Install plugin. It must be Browse: a dragged
   folder is copied and cannot be reloaded (`docs/plugin-authoring-guide.md`).
   A folder install never checks Git for updates.
2. **Sign in to Black 4** in Settings → Black 4. This is the production MCP
   with your own account; see section 3 before you decide anything.
3. **Edit, then reload.** Change `plugins/black4/plugin.js` (or its source,
   then build), and have an agent in this instance call Buzz's own
   `plugin_reload` tool with `{"id": "ai.black4"}`. It stops the plugin,
   loads the new files, waits for activation and restores the previous
   revision if the new one fails. Read its `application` result (`applied`,
   `saved` or `failed`), then `plugin_status` for errors and the tools the
   plugin registered. A changed `manifest.host` is refused until you approve
   it under the plugin's Update in Settings.
4. **Know which code is running.** `plugin_status` and `ctx.pluginOwner.revision`
   show Buzz's revision: sha256 of the stored artifact. Compute the same for
   your folder and compare:
   ```bash
   node -e 'import("./scripts/release/lib.mjs").then(({buzzRevision})=>{const fs=require("fs");console.log(buzzRevision({manifest:fs.readFileSync("plugins/black4/manifest.json","utf8"),code:fs.readFileSync("plugins/black4/plugin.js","utf8")}))})'
   ```

Identity is not isolated by a profile. Development builds share the debug
signing key, and agent keys are shared with the installed app
(`docs/identity.md`, `docs/native-mcp.md`). Do not sign out in the test
instance: it signs out every development build. Let test agents write only in
a scratch channel.

An agent can do all of this without touching your everyday Buzz: start the
development build with its own `BUZZODZ_PROFILE`, ask you once to Browse-install
the folder, then loop on `plugin_reload` and `plugin_status`.

*Not run while writing this page:* this Mac has no Rust toolchain, so the
development build, Browse install and `plugin_reload` steps above are from
Buzz's documentation and source, unverified here. What was checked: the
packaged Buzz.app here is v1.0.5 and single-instance, and `buzzRevision`
reproduces the revision of all ten artifacts this Mac's Buzz stored for
`ai.black4` (and `tests/release.test.mjs` checks one of them in CI).

## 2. Screens, next to Buzz's own

A test cannot see a screen. The screenshot harness renders plugin components
inside Buzz's real built stylesheet beside Buzz's own components, light and
dark, and prints any computed-style difference. It lives outside this
repository, in `~/src/black4-buzz-ui-shots/harness/` (`README.md`,
`main.tsx`, `shots.mjs`, `vite.harness.config.ts`):

1. Export Buzz at a tag into a scratch folder, `pnpm install --frozen-lockfile
   --ignore-scripts`, `npx vite build`: `dist/assets/wght-*.css` is Buzz's
   stylesheet.
2. Copy the harness in, alias `black4-plugin` to your worktree's
   `plugins/black4/plugin.js`, put your component and Buzz's matching
   component in panes, `npx vite build --config vite.harness.config.ts`.
3. Serve `dist` and run `node harness/shots.mjs http://127.0.0.1:4173/harness <folder>`.

Then look at the same screen in your test profile beside Settings. The
harness is not versioned anywhere; moving it into this repository is a
follow-up.

## 3. Real decisions, end to end, without a customer

Reviews are decided against the production Black 4 MCP; there is no staging
server for the plugin to point at. Exercise them on **test-only** items on a
**Black 4 internal or fictional business**, never on a customer's real review:

- Black 4 staff publish with `start_review` and set `testOnly: true` on each
  item. Only Black 4 may set it (a customer's agent is refused with
  `customer_publish_limited`), customers' people never see test items, and
  `apply_approved_change` refuses them, so an approval changes nothing
  anywhere (black4-retail-edge `packages/contracts/src/operations/reviews.ts`,
  `plugins/black4/skills/review-artifacts/SKILL.md`).
- Decide each item in your test profile's Reviews (approve, decline, ask for
  changes), then read it back with `check_review` and confirm the decision,
  reviewer and `executionStatus` you expect. Report execution as `completed`
  with `did_not_go_live`.
- Use fictional names and data in the items. Customer names never go in this
  repository, its tests or its screenshots.

*Not run while writing this page:* creating a test-only review is a
production write, so it was not done without Joey's go-ahead.

## 4. What only a real install shows

The profile loop is a folder install, so these need a Git install, which is
what the `preview` channel is for (README, "Releasing"):

- Buzz's update notice: **Update and reload**, **Review permissions** when
  host access grows, **Later**, and the hourly check and **Check again**.
- The reload itself: the plugin stops for a moment and agents lose their Black
  4 tools until it is back; Buzz restores the previous revision if activation
  fails, and the plugin menu offers **Roll back**.
- Idle Claude sessions starting over when the tools agents see change (Buzz
  keys them on a fingerprint of every plugin tool's name, description and
  schema: `src/buzz-mcp/session-tools.ts` `addedKey`). Whether a plain reload
  with identical tools restarts them, during the moment the tools are gone, is
  not established.
- The embedded sign-in, relayed member mentions, native calls
  (`host.spawn`, `host.serveMcp`) and Black 4 hardware on a real machine.

Black 4 staff who track `preview` see each change from main within the hour.
Promote to `stable` only a commit that has run there.
