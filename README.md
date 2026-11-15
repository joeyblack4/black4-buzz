# Black 4 in Buzz

Status: current  
Owner: Black 4 platform  
Updated: 2026-11-15

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
3. **Sign in.** In **Settings → Black 4**, choose **Sign in**, then **Open
   Black 4 sign-in**. Your browser opens with the code already filled in.
   Check that it matches the code Buzz shows, then approve.
   You should see **Connected**, your email *(staff)* if you are staff, and a
   number of agent tools. **Agent access** says **Linked**.
4. **New agent** (staff). Go to **Agents → New agent → Black 4 hardware**.
   Give it a name, choose what it runs (Claude Code if unsure) and who it
   answers, then **Create**. If the machine isn't signed in to that harness
   yet, the form offers **Sign in**.

### What signing in does

- **Your agents get linked right away.** If this Buzz identity's key isn't
  linked to you yet, signing in links it, so that agents you create on Black 4
  hardware act as you, with exactly your access. Joey approved this on
  2026-11-15. If the key is already linked to someone else, the card says so,
  and nothing is linked. **Remove…** undoes the link, and it stays removed
  until you choose **Link my agents** again. Reconnecting doesn't relink it.
- **You sign in once each time Buzz starts.** Your sign-in is kept in memory
  while Buzz runs: turning the plugin off and on, or reloading it, keeps you
  signed in, but quitting Buzz signs you out. Nothing is written to disk,
  because Buzz gives plugins no private key-value store. The only way to keep
  data is `ctx.artifactStorage`, and that isn't a good home for a refresh
  token: opening a collection starts relay sync queries, a collection belongs
  to one identity and one community, and it is stored as plaintext on disk
  where local agents can read it. The cost is one browser approval per
  launch. Access tokens are refreshed before they expire. Tokens never go into
  logs, into the Settings card or to any agent.
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

Each harness on a machine is signed in once, to the subscription of whoever
signs it in. Every agent on that machine that runs the harness uses that
sign-in:

- **Claude Code** (Claude subscription): open the link, approve, then paste
  the code the Anthropic page shows into the form.
- **Codex** (ChatGPT subscription) and **Grok Build** (SuperGrok or grok.com):
  open the link and approve the short code the form shows. There is nothing to
  paste: the machine notices the approval. The code lasts 15 minutes.

A harness that the machine has installed but Buzz can't sign in (Goose) is
listed as unavailable, with the reason.

You should see the agent in your list with *Claude Code · Commerce Mac* under
its name, and **Status: Running** in its **Settings** tab. @mention it in a
channel: it answers within a minute, and its Black 4 tools work with no
sign-in.

### If something is wrong

- **The plugin does nothing after Install.** It starts off: turn it on in
  **Settings → Plugins**.
- **Settings → Black 4 says *Not signed in*.** Choose **Sign in**. A message
  under the status says why the last sign-in ended: the code expired, the
  sign-in was declined, or *Your Black 4 sign-in ended*.
- **No Black 4 hardware in New agent.** It appears once **Settings → Black 4**
  says **Connected** with a *(staff)* account. If the card instead says
  *Black 4 hardware is unavailable in this Buzz*, this Buzz version changed the
  agent API. Tell the platform team; everything else keeps working.
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

### Buzz updates and releases

The [Buzz canary](canary/README.md) checks every day that the latest Buzz still
offers everything these plugins use; red on the release means do not update
Buzz yet. Work lands on `main`. People install from `stable`, which only Joey
moves, to a tested commit on `main`; installed plugins then offer **Update and
reload**. Until a release, try `main` by installing from GitHub with ref
`main`.

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
from a folder gets no such check. `stable` is what people run; `main` is where
work lands. Releasing is moving `stable` to a tested commit on `main`.

A Mac managed for Black 4 can list the plugin in Buzz's
`managed-plugins.json` so Settings shows it as recommended, pinned to an exact
commit. Buzz never installs it without the person's click.

Updating **Buzz itself** is a separate question: its plugin API is a preview
and can change. The [Buzz canary](canary/README.md) checks every day whether
the latest Buzz release, preview and `main` still offer everything these
plugins use. Its workflow going red on the release means: do not update Buzz
yet.

## What is here

| Path | What it is |
| --- | --- |
| `plugins/<name>/` | Each plugin exactly as Buzz installs it: `manifest.json` and `plugin.js`. Buzz never runs a build, so nothing else belongs in these folders. |
| `subscriptions/` | Source, build and tests for the two subscription plugins. `npm run build --prefix subscriptions` writes their folders under `plugins/`; the check refuses a stale copy. |
| `bridge/black4-agent-mcp/` | The Black 4 MCP for agents that run on a Black 4 machine. `buzz-acp` starts it as the agent's MCP server; it signs every request with the agent's own Buzz key and owner attestation (`Authorization: Nostr`), so there is no sign-in. One pinned dependency, `@noble/curves`. |
| `machine/` | The machine side: `agentctl` (what Black 4 hardware in the plugin calls through the machine's door), `setup.sh` and `deploy.sh <ssh-host>`, which installs it on a machine, and `teammates.sh`, legacy forced-command keys. |
| `install.sh` | Optional: opens Buzz's install review for the plugin, and with `--hardware` / `--check-hardware` sets up legacy direct SSH access for admins. |
| `tests/` | Unit tests against the plugin file: fake AuthKit, MCP and door servers behind `host.request` (`tests/fakes.mjs`), and fictional data. No real sign-in or network. |
| `scripts/check-build-folder.mjs` | Refuses anything in a plugin folder that Buzz would not read. |
| `canary/` | The Buzz canary: the Buzz API each plugin uses (`contract.json`), checked against Buzz's source by `check.mjs` and by starting the plugins in Buzz's real services (`load.mjs`). |
| `machine/pins.json`, `scripts/check-machine-pins.mjs` | The buzz-acp harness and ACP adapter versions an agent machine runs together, and the check that `machine/setup.sh` agrees. |

## Reviews

Only `https://app.black4.ai/reviews` and `/r/:assetId` links match the panel.
The native brief reads through the signed-in MCP account, with access enforced
by the server: the exact action, the recommendation, current and proposed,
consequences, provenance and decision state. The queue belongs to the account
and is never inferred from a channel name. A link is a locator and grants
nothing. A link to an older version is refused, not substituted.

The Reviews dock page opens Black 4's decision inbox in Buzz's embedded
browser, in a website session named `black4-reviews` that is separate from the
MCP sign-in. Decisions are recorded there, by the person. Where Buzz has no
embedded browser (today, anything but macOS), the page shows the native queue
and brief, and "View work & decide" is an ordinary web link. A remembered
website sign-in needs macOS 14 or newer. Buzz labels the embedded browser a
preview API; it has no popups or downloads.

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
the subscription plugins match their source, and the tests pass.
`npm run test:subscriptions` runs the subscription plugins' own tests. To try a change in your own Buzz, install from
your branch (or install the folder again: a folder install is a copy), then use Buzz's `plugin_reload` tool and confirm with
`plugin_status` that it is active and its tools are registered. Unit tests do
not prove the live connection, the embedded sign-in or a relayed mention: check
those in the app.

Customer names never go in this repository: tests use fictional businesses and
people.

## Where the rest lives

- The Black 4 MCP, Reviews and every rule: `joeyblack4/black4-retail-edge`.
- The Black 4 plugin for other agent hosts (Claude Code, Codex and others):
  `plugins/black4` in that repository.
- Agent definitions for the Macs: `joeyblack4/black4-agents`.
