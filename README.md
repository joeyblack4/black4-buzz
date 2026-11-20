# Black 4 in Buzz

Status: current  
Owner: Black 4 platform  
Updated: 2026-11-17

Black 4 runs its AI workforce in [Buzz](https://github.com/block/buzz-app).
Buzz stays stock, so it can be updated at any time; everything Black 4 adds is
a plugin in this repository, one folder each under `plugins/`:

| Plugin | Folder | Who needs it |
| --- | --- | --- |
| **Black 4** (`ai.black4`) | `plugins/black4` | Everyone. Black 4 staff also get **Black 4 hardware** agents from it. |
| **Claude Sub Plugin** (`black4.claude-subscription`) | `plugins/claude-subscription` | A person who wants agents on their own Claude subscription. |
| **Grok Sub Plugin** (`black4.grok-subscription`) | `plugins/grok-subscription` | A person who wants agents on their own Grok subscription. |

## Set up your Buzz

**What you get:** one plugin, **Black 4**. Every agent in your Buzz can use
Black 4 (goals, context, metrics, skills, Reviews) as you, and Reviews shows up
in Buzz's dock. Black 4 staff also get **Black 4 hardware** in Buzz's New agent
dialog, for agents that run on a Black 4 machine and keep working while your
computer is off.

**What you need:** the Buzz desktop app with the Black 4 community open, and
your Black 4 account (the one you use at app.black4.ai). You don't need
Terminal, Node, Tailscale or an SSH key.

1. **Install.** Open
   `buzz://plugin-install?repository=joeyblack4%2Fblack4-buzz&ref=stable&path=plugins%2Fblack4`,
   or go to **Settings → Plugins → Install from GitHub** and enter
   `joeyblack4/black4-buzz`, ref `stable`, path `plugins/black4`. Buzz's review
   says the plugin may reach three addresses: the Black 4 sign-in
   (`overjoyed-tea-41.authkit.app`), the Black 4 MCP (`api.black4.ai`) and the
   Commerce Mac's door (`black4-commerce-01.tail50b7f0.ts.net`). Choose
   **Install plugin**.
2. **Turn it on** in **Settings → Plugins**. Plugins start off.
3. **Sign in.** The first time the plugin starts, Buzz opens **Settings →
   Black 4** by itself with **Sign in to Black 4** ready (press Return or click it). Your
   browser opens with the code already filled in: check that it matches the
   large code Buzz shows, then approve. Buzz updates by itself.
   While you are signed out, the same **Sign in to Black 4** button also sits
   on Reviews (a dot marks the Reviews entry), on review previews in messages
   and in the Black 4 hardware form. You should see **Connected**, your email *(staff)* if you are staff, and a
   number of agent tools. **Agent access** says **Linked**.
4. **New agent** (staff). Go to **Agents → New agent → Black 4 hardware**.
   Give it a name, choose what it runs (Claude Code if unsure) and its
   **Audience** (Staff, unless it is a customer's account manager), then **Create**. If the machine isn't signed in to that harness
   yet, the form offers **Sign in**.

### What signing in does

- **Your agents get linked right away.** If this Buzz identity's key isn't
  linked to you yet, signing in links it, so that agents you create on Black 4
  hardware act as you, with exactly your access. Joey approved this on
  2026-11-15. If the key is already linked to someone else, the card says so,
  and nothing is linked. **Remove…** undoes the link, and it stays removed
  until you choose **Link my agents** again. Reconnecting doesn't relink it.
- **You sign in once per computer.** After you sign in, the plugin keeps
  your Black 4 *refresh token* (only that: never the short-lived access token)
  in Buzz's own web storage (`localStorage`) on this computer, under the key
  `ai.black4.signin.v1:overjoyed-tea-41.authkit.app`. On macOS that is in
  Buzz's WebKit data folder in your user Library; on Windows, in Buzz's
  WebView2 data folder under `%LOCALAPPDATA%`. Quitting and reopening Buzz,
  or updating the plugin, signs you back in without a browser.
  - **Who can read it:** it is stored as plain text, so any program running
    as you on this computer can read it, local agents included, and so can
    any other Buzz plugin you install. Treat this computer's account as
    trusted with your Black 4 access.
  - **To remove it, choose Sign out** in **Settings → Black 4**: the stored
    token is deleted at once. It is also deleted when Black 4 refuses it (your
    sign-in ended) and replaced when you sign in again. A dropped network
    never deletes it.
  - If Buzz's web storage is blocked or fails, the sign-in is kept in memory
    only and you sign in again after a restart; a failed write leaves what
    was stored for the other windows. A value under the key that isn't this
    plugin's (corrupt, or another version's) counts as no sign-in and is
    left alone until you sign in.
  - Only a refused refresh token (`invalid_grant`) deletes it. A sign-in
    server error, or a misconfiguration such as `invalid_client`, shows *Not
    connected* and keeps it.
  - Signing out in one Buzz window signs the others out at their next token
    refresh (within about five minutes).
  - Buzz opens **Settings → Black 4** at its Sign in by itself only the first
    time a newly installed or updated plugin starts without a kept sign-in,
    and if a sign-in ends while Buzz runs. A kept sign-in that Black 4 refuses
    at launch is removed and shown in place with its reason. Otherwise choose **Sign in to
    Black 4** wherever you are; a dot on the Reviews entry reminds you.
  - Access tokens are refreshed before they expire. Tokens never go into
    logs, into the Settings card or to any agent.
- **Black 4 may ask you to approve your sign-in again.** Platform Control
  limits a sign-in kept on disk, and only its `renew_signin` approval renews
  it (signing in again does not):
  - **Hardware:** a hardware pass needs an approval from the last 24 hours.
    The hardware form and the agent's Settings show **Approve in browser**.
  - **Linking your agents** needs one too: Agent access shows **Approve in
    browser** (*Linking waits for your approval*) and links by itself once
    you approve. An agent whose call needs it is told to ask you, and
    Settings → Black 4 shows the same Approve.
  - **Unused for 14 days:** Black 4 refuses everything until you approve.
    Every surface shows **Approve in browser** and the Reviews entry a dot.
  Either way you stay signed in and the kept sign-in is not removed. Approve
  shows a code, large and copyable, and opens your browser, as signing in
  does. Once you approve there, this window reconnects (idle) or reads the
  machine again (hardware) by itself; an action such as **Create** is chosen
  again. Cancel and Approve again picks up the same code. Approved in
  another Buzz window? This one notices when you come back to it or press
  Approve, without a second approval.
- **Until you sign in after a launch**, Buzz's own agents can't use Black 4
  tools, and **Black 4 hardware** isn't offered. Your existing hardware agents
  keep running on the machine, but Buzz shows them as *Harness unavailable*
  until you sign in.
- **Each request to Black 4 hardware carries its own pass.** For every
  request, the plugin asks Platform Control for a pass (staff only) that is
  bound to that exact request and expires after 60 seconds. It then sends the
  request and the pass to the machine's public HTTPS door. Nothing reaches the
  machine without your sign-in. The pass names this Buzz identity's key as
  its owner, so it matches the attestation that this Buzz signs. Only the
  hardware agent type mints passes. Buzz's agents never can, not even through
  `call_tool`.

Each person signs each harness in to their own subscription (or adds their
own API key). Your agents on the machine run only on your sign-ins, never on
anyone else's: an agent whose creator has not signed its harness in does not
start, and the Create agent form shows your own sign-in, with **Sign in** when
you have none. Signing out removes only yours:

Each harness has two ways to pay, a **subscription** and an **API key**, and
each agent chooses one (**Pays with** in the form and in its Settings). A new
agent pays by subscription when the machine's subscription for that harness
is signed in, else by key, and keeps that until you change it. Each agent
sees only the sign-in it pays with.

- **Subscription.**
  - **Claude Code** (Claude subscription): open the link, approve, then paste
    the code the Anthropic page shows into the form.
  - **Codex** (ChatGPT), **Grok Build** (SuperGrok or grok.com) and **Qwen
    Code** (a Qwen membership, Plus or Pro on chat.qwen.ai): open the link
    and approve the short code the form shows. There is nothing to paste: the
    machine notices the approval. The code lasts 15 minutes.
- **API key.** Open the link to the service's keys page, make a key there and
  paste it into the form (**Add key**). The machine checks it against the
  service's model list, keeps it to itself in its own home for that harness,
  and it never comes back to Buzz: an Anthropic key for Claude Code, an
  OpenAI key for Codex (Codex keeps its own copy in that home, the way its
  `login --with-api-key` does), an xAI key for Grok Build, a QwenCloud key for
  Qwen Code (pay-as-you-go or Token Plan).

Qwen Code runs in a private home per sign-in with its self-update, usage
statistics and managed memory off (`tools.toolOutputBatchBudget` 100k
characters). When an agent compacts its context is its own setting, **Compact
at** next to Model and Thinking (a new agent: 150k tokens; *Harness default*
leaves it to the harness), through the lever each harness has per process;
where a harness has none, or the machine does not know the model's window yet,
the choice is greyed with the reason. Black 4 tool results are large, so this
is what keeps a long session from re-reading them on every request. New agents run `qwen4-max` (or the next
model that sign-in lists), with no effort setting: Qwen Code has no effort
lever for a model it is given this way, so the service's default thinking for
the model applies.

A harness that the machine has installed but Buzz can't sign in (Goose) is
listed as unavailable, with the reason.

The form and the agent's tabs are Buzz's own rows. **Identity** holds
Harness, Model, Thinking, Compact at and Instructions. **Settings** holds the
machine (Runs on and Runs, fixed for an agent's life; Pays with, Sign-in, Status
with Restart, Audience), the
Heartbeat (on or off, how often it wakes, and what it does each time) and
**Conversations**: buzz-acp's own levers for this agent (Parallel work, Session
per, New message while working, Fresh session after, Max turn length, Context
for replies), each at buzz-acp's default until you choose one. A choice in a
dropdown applies at once; Instructions and the heartbeat prompt have Save.
The Create form offers the same rows at their defaults.

You should see the agent in your list with *Claude Code · Commerce Mac* under
its name, and **Status: Running** in its **Settings** tab. @mention it in a
channel: it answers within a minute, and its Black 4 tools work with no
sign-in.

### If something is wrong

- **The plugin does nothing after Install.** It starts off: turn it on in
  **Settings → Plugins**.
- **Settings → Black 4 shows only Sign in to Black 4.** You are signed out:
  choose it. A line above it says why the last sign-in ended, if it did: the
  code expired, the sign-in was declined, or *Your Black 4 sign-in ended*.
  If your browser did not open, choose **Open sign-in page**.
- **No Black 4 hardware in New agent.** It appears once **Settings → Black 4**
  says **Connected** with a *(staff)* account. If the card instead says
  *Black 4 hardware is unavailable in this Buzz*, this Buzz version changed the
  agent API. Tell the platform team; everything else keeps working.
- **New agent says *Your agents are not linked to you on this Buzz
  identity*.** This Buzz identity's key isn't one of your live links: it was
  never linked, it was removed, or it belongs to someone else. Choose **Link
  my agents** (in the form or in Settings → Black 4), then try again.
- **The card says your agents are not linked, because the key is linked to
  another person.** That person, or any staff member, removes their link
  first. Then choose **Link my agents**.
- **"Could not reach the Commerce Mac"** in the New agent dialog. The rest of
  the message says which part failed:
  - *your Black 4 sign-in could not get a pass*: sign in again, or your
    account isn't staff.
  - *its door did not answer*, or *its door answered HTTP …*: the machine or
    its door is down or busy. Tell an admin.
  - *its door refused the pass*: the pass was expired or already used, or (on
    activate) it was for a different owner than the agent's attestation. Try
    again; if it keeps happening, tell an admin.
- **A change in this repository doesn't show up.** A plugin installed from a
  folder is a copy taken at install time. Install it again, then ask a Buzz
  agent to run `plugin_reload`. Plugins installed with the link above update
  themselves (**Update and reload** in Settings).
- **After updating from an older Black 4 plugin**, Buzz asks you to review the
  update. The old version started programs on your computer; this one only
  reaches the three addresses above. Approve it, then sign in. You can delete
  the old `~/.black4/mcp-bridge` folder, `~/.local/bin/black4-mcp-bridge`, and
  `~/.mcp-auth` (if nothing else uses it).

Windows: nothing in the plugin is Mac-specific any more, but nobody has tried
it on Windows yet.

## Admin

### Set up a new machine

On a Mac with Apple Silicon, signed in as the user agents run under, with
your SSH key in its `authorized_keys` and an SSH alias for it on your computer:

```sh
machine/deploy.sh <ssh-host> [machine-name]
```

It installs Node, the ACP adapters, the Black 4 connector and `agentctl` under
`~/workforce`, without sudo, and is safe to run again. It ends with
`agentctl doctor`, a self-test: each harness at its pinned version
(`machine/pins.json`), buzz-acp's ACP handshake with each adapter, the
connector, the cron lines and free disk. It fails loudly when the machine cannot
run agents; Buzz's Create agent form shows the same problem for a harness
instead of creating an agent that never answers. Then sign the machine in
to Claude from Buzz (the Create agent dialog offers it). The plugin reaches a
machine only through its public HTTPS door (Tailscale Funnel in front of
`agentctl`, which checks each request's Platform Control pass). A second
machine needs an entry in `MACHINES` in `plugins/black4/plugin.js` with its
door's origin, and that origin in the manifest's `networkOrigins`. Existing
installs then ask the person to review the update.

Cron runs `agentctl supervise` at boot and every minute; it restarts an agent
that stops, waiting 5, 10, 20 … up to 300 seconds while it keeps stopping, and
`status` then says `keepsStopping` with the end of its log. Each agent's
`agent.log` is cut over to `agent.log.1` past 5 MB.

Agents run with full access on their own machine: no harness asks permission
or runs sandboxed (`FULL_ACCESS` in `agentctl`; `doctor` shows each one's mode).
Changes to a customer's systems are gated by Reviews in Platform Control.

Every agent knows what it is: its home holds a short note, in its CLI's own
instructions file (`CLAUDE.md`, `AGENTS.md`, `QWEN.md`), saying it is a
Black 4 hardware agent on this machine, which folder is its own, and the exact
`agentctl` commands to read and change its heartbeat, model, effort,
instructions, and to restart. When an agent changes itself from its shell (a
person asked it to), `agentctl` sees the request comes from inside the
agent's own process tree, saves the change at once and answers `"applies":
"after this turn"`; a detached waiter restarts it once no turn is in flight
(agents run with buzz-acp's ACP wire log on for this; buzz-acp writes to a
private `agent.raw.log` and a filter follows it into `agent.log`, keeping
bare "turn opened" and "turn closed" lines and dropping the wire, which
carries the agent's key and everything the model says), so the turn that
asked still finishes and its reply posts. A change made by
a person restarts the agent at once, as before. Job schedules are not the
agent's to change here: they live in Platform Control.

### Buzz updates and releases

The [Buzz canary](canary/README.md) checks every day that the latest Buzz still
offers everything these plugins use; red on the release means do not update
Buzz yet. Releasing the plugins, the `preview` channel and rollback are in
[Releasing](#releasing).

### Legacy: direct SSH to a machine's agentctl

Before the door, the plugin ran `ssh commerce workforce/bin/agentctl` with a
teammate's forced-command key. The plugin no longer does that, and teammates
need no key. These steps remain only for admins who want direct access
to `agentctl` for debugging, and for machines that do not have a door yet.

On the computer that will connect:

```sh
curl -fsSL https://raw.githubusercontent.com/joeyblack4/black4-buzz/stable/install.sh | sh -s -- --hardware <user>@<address>
curl -fsSL https://raw.githubusercontent.com/joeyblack4/black4-buzz/stable/install.sh | sh -s -- --check-hardware
```

`--hardware` makes `~/.ssh/black4_hardware`, adds a `commerce` entry to
`~/.ssh/config` (your own entries are left alone) and prints a public key
line. Add it from a computer that already reaches the machine:

```sh
machine/teammates.sh --host commerce add sam 'ssh-ed25519 AAAA… black4-hardware'
machine/teammates.sh --host commerce list
machine/teammates.sh --host commerce remove sam
```

The label (`sam`) is how the machine records who created each agent. Each line
it writes forces `agentctl --caller <label>` with `restrict` (no shell, no
forwarding, no pty), so the key can only send agentctl one JSON request.
Removing a key leaves that person's agents running; `agentctl list` still
shows them, with `createdBy`. On the machine, a labelled caller can see every
agent but change, restart or remove only the agents they created. They can
sign a harness in while it is signed out, but cannot sign it out. Your own key
is not limited.

## Black 4 hardware, inside the Black 4 plugin

`plugins/black4/plugin.js` ends with a fenced Black 4 hardware part: the
hosted agent type and its form, sign-in and Settings tab. It is offered only
after `whoami` reports a staff account, and withdrawn when a connected account
is not staff or the person signs out (a dropped connection changes nothing). It registers in its own
child scope, because Buzz has no call to remove an agent type: disposing that
scope withdraws it. While it is withdrawn, an existing hardware agent shows in
Buzz as *Harness unavailable* with no Delete, and keeps running on the machine;
it comes back when the type does. If registering or rendering it throws, the
MCP tools, Reviews and Agent access carry on and **Settings → Black 4** says
*Black 4 hardware is unavailable in this Buzz* with the reason.

## The rule this repository keeps

The plugin is a client of Black 4. It never defines a tool, a number, a
permission or a review rule of its own: those live in Platform Control and are
reached through the MCP. People decide in Reviews; no agent tool records a
decision. No customer data is stored here or in the plugin.

## Updates

Each plugin's manifest declares `"updates": { "defaultEnabled": true }`, so Buzz
checks a plugin installed from this repository against the branch it was
installed from (at startup, then hourly) and offers **Update and reload**. An
update that asks for more computer access needs a review first. A plugin loaded
from a folder gets no such check. Buzz compares the plugin's contents, not Git
history, so a commit that leaves a plugin's folder alone offers no update, and
moving a branch back offers the older plugin like any other update.

## Releasing

Three branches, one direction:

| Branch | Who runs it | How it moves |
| --- | --- | --- |
| `main` | Nobody's Buzz. | Pull requests, after the `required` check passes. |
| `preview` | Black 4 staff who opt in. | CI moves it to every commit on `main` whose checks pass ([preview.yml](.github/workflows/preview.yml)). |
| `stable` | Everyone else. | Only the release and rollback workflows. |

**Put a Mac on preview (or back on stable)** without removing the plugin:

```bash
node scripts/release/channel-link.mjs preview
```

It prints a `buzz://plugin-install` link pinned to preview's current commit
and the plugin's folder. Open it on that Mac: Buzz shows an **Update** review
that names the new branch, and later updates follow it. A link without the
commit, or **Install from GitHub**, only says *Already installed*. If Buzz says
the plugin is up to date, both branches hold the same plugin right now and the
link changes nothing; run it again after the next change reaches preview. Use
`stable` in place of `preview` to go back.

**Release** an exact commit that has run on preview:

```bash
gh workflow run release -f commit=<sha>
```

The workflow runs the Buzz canary on that commit against the Buzz release
Update installs now. Then [promote.mjs](scripts/release/promote.mjs) refuses,
in one sentence, unless the commit is on `main`, has reached `preview`, is
newer than `stable`, has a green `required` check, and its built folders match
their source. It also refuses when a manifest asks for more host access than
`stable` has, unless `-f ack_permissions=true` says everyone will be asked to
review permissions. It tags the commit `release-YYYYMMDD-N` and writes notes
from the merged pull requests, naming each plugin's Buzz revision and whether
people are offered an update. Then it moves `stable`. Buzz offers the update
within the hour, or at once with **Check again**. Try it first with
`-f dry_run=true`, or locally with
`node scripts/release/promote.mjs <sha> --dry-run`.

**Roll back** the current release:

```bash
gh workflow run rollback
```

[rollback.mjs](scripts/release/rollback.mjs) moves `stable` back to the
previous release tag (or `-f to=release-…`) and records a `rollback-…` tag
naming the commit it undid, which promote then refuses to release again.
Because Buzz compares contents, every install on `stable` is offered the older
plugin as an ordinary update within the hour. `main` and `preview` still hold
the bad commit, so land a fix on `main`. A Mac whose `managed-plugins.json`
pins the undone commit stops matching `stable` until the pin is updated. One
person who cannot wait can use **Roll back** in the plugin's menu in Buzz.

How to test before any of this: [docs/testing.md](docs/testing.md).

A Mac managed for Black 4 can list the plugin in Buzz's
`managed-plugins.json` so Settings shows it as recommended, pinned to an exact
commit. Buzz never installs it without the person's click.

Updating **Buzz itself** is a separate question: its plugin API is a preview
and can change. The [Buzz canary](canary/README.md) checks every day whether
the latest Buzz release, preview and `main` still offer everything these
plugins use, and still paint the UI kit as Buzz paints its own screens. Its workflow going red on the release means: do not update Buzz
yet.

## What is here

| Path | What it is |
| --- | --- |
| `plugins/<name>/` | Each plugin exactly as Buzz installs it: `manifest.json` and `plugin.js`. Buzz never runs a build, so nothing else belongs in these folders. |
| `subscriptions/` | Source, build and tests for the two subscription plugins. `npm run build --prefix subscriptions` writes their folders under `plugins/`; the check refuses a stale copy. |
| `bridge/black4-agent-mcp/` | The Black 4 MCP for agents that run on a Black 4 machine. `buzz-acp` starts it as the agent's MCP server; it signs every request with the agent's own Buzz key and owner attestation (`Authorization: Nostr`), so there is no sign-in. One pinned dependency, `@noble/curves`. |
| `machine/` | The machine side: `agentctl` (what Black 4 hardware in the plugin calls through the machine's door), `setup.sh` and `deploy.sh <ssh-host>`, which installs it on a machine, and `teammates.sh`, legacy forced-command keys. |
| `scripts/release/` | Releasing: `promote.mjs`, `rollback.mjs`, `preview.mjs` and `channel-link.mjs` ([Releasing](#releasing)). `scripts/pr-gates.mjs` and `scripts/tool-surface.mjs` say what a pull request does to people's Buzz. |
| `install.sh` | Optional: opens Buzz's install review for the plugin, and with `--hardware` / `--check-hardware` sets up legacy direct SSH access for admins. |
| `tests/` | Unit tests against the plugin file: fake AuthKit, MCP and door servers behind `host.request` (`tests/fakes.mjs`), and fictional data. No real sign-in or network. |
| `scripts/check-build-folder.mjs` | Refuses anything in a plugin folder that Buzz would not read. |
| `canary/` | The Buzz canary: the Buzz API each plugin uses (`contract.json`), checked against Buzz's source by `check.mjs` and by starting the plugins in Buzz's real services (`load.mjs`)., and the Buzz design the UI kit draws with (`design.mjs`). |
| `kit/` | The Buzz UI kit: Buzz's own design-system primitives, which every plugin screen is drawn with. `npm run kit` stamps it into each plugin. Rules in [kit/README.md](kit/README.md). |
| `machine/pins.json`, `scripts/check-machine-pins.mjs` | The buzz-acp harness and ACP adapter versions an agent machine runs together, and the check that `machine/setup.sh` agrees. |

## Reviews

Reviews is native in Buzz: the dock page, the side panel, a card under each
message that links reviews, a **Decisions** section in the Team sidebar and two
notification switches (a decision waiting; approved work blocked). It never
opens the Black 4 Reviews website. Its source is `src/reviews/`, stamped into
`plugins/black4/plugin.js` by `npm run build`, and it starts in its own child
scope, so a fault there is one line in **Settings → Black 4** and never stops the
MCP connection or the agent tools.

- **Work first.** The question, the stake and facts as chips, then the change
  itself (fields as Now and After, text as a word diff, a list, before and
  after images, or the finished page), and the recommendation in one line.
  Why, evidence, provenance and the pinned request sit in one closed
  **Details**.
- **Decide in place.** Approve, Ask for changes and Reject sit in a bar at the
  bottom; the last two take feedback in place. A decision waits 8 seconds for
  **Undo**; nothing reaches Black 4 before then. Each item then shows its own
  receipt: saved, changed (a newer version or someone else's decision, with
  **Load the new version**), failed (**Try again**), or unconfirmed (read again
  before anything is claimed). Approval is never shown as done: the item's own
  execution status says waiting, running, blocked or done.
- **Fast.** The page opens on the first waiting item. **J**/**K** or the arrows
  step through everything waiting, in queue order; **A** approves, **C** asks
  for changes, **R** rejects; a saved decision moves on by itself. Items of one
  business and one kind of work sit together. Buzz has no swipe gesture, so
  neither does Reviews.
- **What approving writes to.** The top right of an open decision names the
  system its pinned request changes ("Updates Google Ads", "Updates Shopify"),
  named only from that request the way Platform Control names it, never from
  the action sentence; feedback on a document says "Writes nothing". When one
  review holds several decisions over one page of work, the decision says
  which it is ("Decision 2 of 3 in …"). A generic title such as "Review this
  document" gives way to the review's own title.
- **Customer menu.** Beside Goal, a Customer menu narrows Reviews to one
  business: "All customers" and every business with decisions waiting, each
  with its count. The **Decisions** section in the sidebar lists the same
  businesses and counts. The queue lists at most 50 items, so both use
  `review_queue`'s `businesses` counts, never what the list holds (an older
  server sends none; then the listed items are counted). Choosing a business
  asks Black 4 for its queue and opens its first decision.
- **Bulk approve.** Pick items in the queue (nothing is picked for you), then
  **Approve N**. Each is still its own decision with its own token and receipt;
  a partial failure shows per item. Ask for changes and Reject stay one at a
  time.
- **Goal filter.** When reviews in the queue serve goals (the goals of the job
  that made each one), a Goal menu narrows the list to one goal, or to those
  serving none: "All goals", each goal with its count of waiting reviews, and
  "No goal". The queue is capped, so Black 4 filters and counts:
  `review_queue` with `goal`, and its `goals` and `noGoal` counts. Next and
  previous, the keys, bulk approve and the list's counts follow what it shows;
  the dock badge keeps the whole queue's count. The choice is kept per
  business for the session and falls back to All goals when that goal's last
  review is decided. When Black 4 counts no goals (or is older), the menu is
  not drawn.

A link is a locator and grants nothing; the server checks every read. Only this
plugin's Reviews code calls `decide_review_item`, only after a person's click
or key, with the single-use decision token `open_review` hands it in `_meta`.
Tokens live in memory inside Reviews: never logged, stored, rendered or put in
a URL. Agents are never offered an app-only tool (`_meta.ui.visibility`
without `"model"`, or `decide_review_item`, `void_review`, `restore_review` by
name), and are refused one directly or through `call_tool`. When Black 4 issues
no token on this connection, the bar says deciding isn't available yet, with
**Retry**.

## Everyone in a channel reaches its agents

Buzz 1.0 starts an agent's turn for an @mention only when the agent's owner, or
the owner's own agent, wrote it, and it never shows an @mention to the agent's
Attention watches. No Buzz setting changes either. So the plugin relays the
rest: when a person other than the owner @mentions one of the owner's agents
running on this Mac, the plugin wakes that agent in the message's thread with
`ctx.agents.wake`, saying who asked and what they wrote.

The owner's own mentions and every agent's message (which carries a NIP-OA
`auth` tag) are left to Buzz, so nothing is woken twice and agents cannot loop.
It covers new messages only, while this Buzz app is open in that community.
Claude, Codex, goose and plugin agent types take these wakes; Pi ignores them.

Installing the plugin is the owner's choice to let every channel member direct
their agents, which run commands and Black 4 calls with the owner's authority.
A setting to limit this to chosen channels is not built yet.

## Every staff member's agents

Buzz's **Your agents** lists only the agents your own Buzz made. The
**Black 4 agents** page lists every Black 4 hardware agent on every machine,
with who made it, and **Open** shows the same Settings its maker sees: any
staff member changes its instructions, model, heartbeat and how it answers,
and restarts it. An agent always runs on its maker's own sign-in, whoever
changes it; only its maker (or an admin) removes it.

## Whom an agent answers

Staff and customers share one Buzz community (Joey, 2026-11-17), so every
Black 4 hardware agent answers exactly one **Audience**:

- **Staff** (every new agent's): Black 4 staff only.
- **One business**: staff, plus the people linked to that customer business.
  This is what a customer's account manager runs.
- **Only me** and **Everyone** are in Settings only. Everyone is only for an
  agent that holds no business data, and is never a default.

The machine asks Platform Control (`get_buzz_audience`, signed as the agent)
whose Buzz keys that audience holds, when the agent starts and about every 10
minutes, and buzz-acp answers only those keys (`BUZZ_ACP_RESPOND_TO=allowlist`).
It asks again at once (at most once a minute) when the agent's gate drops a
mention, so a person who has just linked their key is not left waiting for the
10-minute check. buzz-acp reads the list only when it starts, so a changed list
restarts the agent: at once when it is idle, otherwise once no turn is in flight
(with parallel sessions, all of them), and after 10 minutes the hard way. A
person on the new list whose mention was dropped meanwhile gets one line from
the machine (not the model) to mention it again in a few minutes; anyone else
gets nothing, and the agent's settings show its owner how many mentions it did
not hear. A
failed check keeps the last list, except that an agent whose business seat ended
(`agent_unseated`) drops it and answers only its owner. An agent that has never had a list answers only its owner. Until
Platform Control has `get_buzz_audience`, the staff list in
[`machine/staff.json`](machine/staff.json) stands in for it.

What buzz-acp 0.5.30 does with the list: channel messages and their threads
pass when the author is listed, is the agent's owner, or is another agent of
the same owner. **Direct messages are never opened up by the list:** only the
owner and the owner's own agents get a DM answered. Reach someone else's agent
with an @mention in a channel or a thread.

`agentctl list` on the machine prints each agent's audience: for example,
*Opus Code: staff (allow-list of 4 from machine)*.

## Customer-facing agents

Staff agents keep full access. An agent that customers talk to (an account
manager) is made with `access: "platform"` instead:

- It runs Claude Code with only the Black 4 MCP and WebFetch. It has no shell,
  no file tools and no subagents. Two locks each refuse everything else:
  Claude Code's deny rules, which take those tools off its list, and a
  `PreToolUse` hook (`agentctl tool-gate`). It never runs in
  `bypassPermissions`. Checked through claude-agent-acp on the Commerce Mac.
- **Its Black 4 access is still its owner's.** Black 4 acts as the person whose
  Buzz key the agent attests. An account manager owned by a staff member can
  read every business until Platform Control limits a seated agent to its
  business.
- Its audience is one business.
- It runs as a separate macOS user with its own `~/workforce`, so it cannot
  read the staff agents' keys or sign-ins. The main runner forwards every
  request about it to that user with `sudo -u`, along with its creator's Claude
  sign-in.

A Black 4 admin sets up that user once, on the machine, with the admin's
password:

```bash
sudo sh ~/workforce/.staging/machine/platform-user.sh
```

After that, `machine/deploy.sh` installs the release for that user too.

## Agents on your own Claude or Grok subscription

The two subscription plugins add agent types that run the provider's official
command-line tool on your computer, signed in as you: Claude Code for Claude,
Grok Build for Grok. Install either from its folder:

```
buzz://plugin-install?repository=joeyblack4%2Fblack4-buzz&ref=stable&path=plugins%2Fclaude-subscription
buzz://plugin-install?repository=joeyblack4%2Fblack4-buzz&ref=stable&path=plugins%2Fgrok-subscription
```

Then open **Agents → New agent**, choose the type, and use **Install CLI** and
**Sign in** if the tool is not set up yet. Each person uses their own
subscription on their own computer. Credentials stay in the provider's own
storage; the plugin copies none into Buzz. It removes API-key overrides from
the processes it starts, so work runs on the subscription sign-in, and it never
changes a plan or buys credits. Your use of a subscription this way is subject
to that provider's terms.

Limits today: macOS is the tested platform; a session restarts from Buzz's
history when the plugin reloads; detailed activity transcripts and protected
execution are not built.

## Lifecycle and authority

Everything goes through Buzz's `host.request` to the three declared origins;
the plugin starts no process. Reconnect, sign-out and disable invalidate an
older attempt, so a late answer is dropped. `host.request` has no cancel and
a 180-second ceiling: an agent's Stop ends its wait at once, and a call longer
than three minutes times out. A lost MCP session is opened again; a 401
refreshes the sign-in and asks once more.

When the MCP lists `resolve_channel_business`, the plugin fills in the calling
agent's exact channel and community. A channel name never selects a business,
and nothing here prescribes how agents use channels. The MCP enforces authority
under the signed-in person's account, as it does in every other harness.

Agent results contain textual MCP content only. Private `_meta`, including
human decision tokens and preview grants, never goes into an agent result.

## Work on it

```sh
npm run setup   # once: the connector's pinned dependency
npm run check
```

That checks the plugin parses, each plugin folder holds only what Buzz reads,
the subscription plugins and the UI kit's copies match their source, and the
tests pass. Screens are drawn only with the [Buzz UI kit](kit/README.md).
`npm run test:subscriptions` runs the subscription plugins' own tests. To try a change in Buzz, use a Buzz profile of its
own, never your everyday install: install the folder with **Browse**, then use Buzz's `plugin_reload` tool and confirm with
`plugin_status` that it is active and its tools are registered
([docs/testing.md](docs/testing.md)). Unit tests do
not prove the live connection, the embedded sign-in or a relayed mention: check
those in the app.

Customer names never go in this repository: tests use fictional businesses and
people.

## Where the rest lives

- The Black 4 MCP, Reviews and every rule: `joeyblack4/black4-retail-edge`.
- The Black 4 plugin for other agent hosts (Claude Code, Codex and others):
  `plugins/black4` in that repository.
- Agent definitions for the Macs: `joeyblack4/black4-agents`.
