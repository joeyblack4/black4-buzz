# Black 4 in Buzz

Status: current  
Owner: Black 4 platform  
Updated: 2026-11-14

Black 4 runs its AI workforce in [Buzz](https://github.com/block/buzz-app).
Buzz stays stock, so it can be updated at any time; everything Black 4 adds is
a plugin in this repository, one folder each under `plugins/`:

| Plugin | Folder | Who needs it |
| --- | --- | --- |
| **Black 4** (`ai.black4`) | `plugins/black4` | Everyone. |
| **Black 4 Hardware** (`black4.hardware`) | `plugins/hardware` | Anyone who creates agents that run on a Black 4 machine. |
| **Claude Sub Plugin** (`black4.claude-subscription`) | `plugins/claude-subscription` | A person who wants agents on their own Claude subscription. |
| **Grok Sub Plugin** (`black4.grok-subscription`) | `plugins/grok-subscription` | A person who wants agents on their own Grok subscription. |

## Set up your Buzz (Black 4 staff)

**What you get:** every agent in your Buzz can use Black 4 (goals, context,
metrics, skills, Reviews) as you; Reviews in Buzz's dock; and **Black 4
hardware** in Buzz's Create agent dialog, for agents that run on a Black 4
machine and keep working while your computer is off.

**What you need first:**

- The Buzz desktop app, signed in, with the Black 4 community open.
- A Black 4 staff account (the one you use at app.black4.ai).
- Node 22.12 or newer (`node -v`; get it from [nodejs.org](https://nodejs.org)).
- For hardware: the company network (Tailscale on), and a Black 4 admin
  (Joey) who will give you the machine's `<user>@<address>` and add your key.
- A Mac. Windows: see [On Windows](#on-windows) first.

Open Terminal for the commands below.

### 1. The Black 4 plugin and sign-in

```sh
curl -fsSL https://raw.githubusercontent.com/joeyblack4/black4-buzz/stable/install.sh | sh
```

It installs the sign-in bridge, then Buzz opens its install review for
**Black 4**. Choose **Install plugin**. Then in **Settings → Plugins**, turn
**Black 4** on (plugins start off). Your browser opens the Black 4 sign-in;
sign in as yourself.

You should see: **Settings → Black 4** says **Connected**, signed in as your
email, with a number of agent tools. **Reviews** appears in the dock.

### 2. Link your agents (one click)

In **Settings → Black 4**, the **Agent access** card says *Agents you create
on Black 4 hardware need this to use Black 4 as you.* Choose **Link my
agents**.

You should see: **Linked** with today's date. Later it counts the agents that
used it. **Remove…** undoes it.

This tells Black 4 that agents your Buzz identity creates act as you, with
exactly your access and no more. It is never done without your click.

### 3. The hardware plugin and machine access

Your admin gives you the machine's `<user>@<address>`. Then:

```sh
curl -fsSL https://raw.githubusercontent.com/joeyblack4/black4-buzz/stable/install.sh | sh -s -- --hardware <user>@<address>
```

It makes a key used only for Black 4 machines (`~/.ssh/black4_hardware`),
adds a `commerce` entry to `~/.ssh/config` (your own entries are left alone),
prints one line starting `ssh-ed25519`, and opens Buzz's install review for
**Black 4 Hardware**. Choose **Install plugin** and turn it on in
**Settings → Plugins**.

Send the printed line to your admin (it is a public key; safe to paste in
chat). When they say you are added, check:

```sh
curl -fsSL https://raw.githubusercontent.com/joeyblack4/black4-buzz/stable/install.sh | sh -s -- --check-hardware
```

You should see: `Black 4 hardware reached:` and what the machine can run.

### 4. Your first agent on Black 4 hardware

In Buzz, **Agents → New agent**. Choose **Black 4 hardware**, give it a name
and choose what it runs (Claude Code if unsure) and who it answers. Create.

You should see: the agent in your list with *Claude Code · Commerce Mac*
under its name. Its **Settings** tab shows **Status: Running**. @mention it in
a channel; it answers within a minute, and its Black 4 tools work with no
sign-in.

### If something is wrong

- **The plugin does nothing after Install.** It starts off: turn it on in
  **Settings → Plugins**. Black 4 says *Not connected*: choose **Connect**,
  and finish the browser sign-in.
- **An agent says no Black 4 person has linked its owner key.** Do step 2.
  The card says the key is linked to someone else: that person (or any staff
  member) removes their link first.
- **"Could not reach the Commerce Mac"** in the Create agent dialog. Turn
  Tailscale on and run `--check-hardware`. *The machine refused this key*
  means the admin has not added your line yet.
- **A change in this repository doesn't show up.** A plugin installed from a
  folder is a copy taken at install time: install it again, then ask a Buzz
  agent to run `plugin_reload`. Plugins installed with the links above update
  themselves (**Update and reload** in Settings).

### On Windows

Untested. What is known from Buzz's source: Buzz for Windows starts a
plugin's program by name, and Windows 10 and 11 ship the OpenSSH client
(`ssh.exe`), so the hardware plugin's `ssh` should start. The Black 4 plugin's
sign-in bridge is a shell script and does **not** start on Windows today, and
`install.sh` needs a POSIX shell. Until that is built:

1. Step 2 another way: in Claude (or any app with the Black 4 MCP), ask it to
   call `link_agent_owner_key` with your Buzz public key as 64 hex characters
   (Buzz shows it in Settings; Claude can convert an `npub`).
2. Step 3 by hand, in PowerShell:

   ```powershell
   ssh-keygen -t ed25519 -C black4-hardware -f "$env:USERPROFILE\.ssh\black4_hardware" -N '""'
   Get-Content "$env:USERPROFILE\.ssh\black4_hardware.pub"   # send this line to your admin
   notepad "$env:USERPROFILE\.ssh\config"
   ```

   Add to the end of that file, with the values your admin gave you:

   ```
   Host commerce
     HostName <address>
     User <user>
     IdentityFile ~/.ssh/black4_hardware
     IdentitiesOnly yes
     StrictHostKeyChecking accept-new
   ```

   Install the hardware plugin from
   `buzz://plugin-install?repository=joeyblack4%2Fblack4-buzz&ref=stable&path=plugins%2Fhardware`
   and check with
   `'{"op":"machine.status"}' | ssh -o BatchMode=yes commerce workforce/bin/agentctl`.

## Admin

### Add or remove a teammate

From a computer that already reaches the machine (yours has `commerce`):

```sh
machine/teammates.sh --host commerce add sam 'ssh-ed25519 AAAA… black4-hardware'
machine/teammates.sh --host commerce list
machine/teammates.sh --host commerce remove sam
```

The label (`sam`) is how the machine records who created each agent. Each
line it writes forces `agentctl --caller <label>` with `restrict` (no shell,
no forwarding, no pty), so a teammate's key can only send agentctl one JSON
request. Your own key stays unrestricted. Removing a key leaves their agents
running; `agentctl list` still shows them, with `createdBy`.

On the machine, a teammate can see every agent but change, restart or remove
only the agents they created, and cannot sign the machine out of Claude. They
can sign the machine in to Claude when it is signed out, which every Claude
agent on it then uses. Agents made before labels existed, and anyone using an
unrestricted key, are not limited.

### Set up a new machine

On a Mac with Apple Silicon, signed in as the user agents run under, with
your SSH key in its `authorized_keys` and an SSH alias for it on your computer:

```sh
machine/deploy.sh <ssh-host> [machine-name]
```

It installs Node, the ACP adapters, the Black 4 connector and `agentctl` under
`~/workforce`, without sudo, and is safe to run again. Then sign the machine in
to Claude from Buzz (the Create agent dialog offers it). A second machine also
needs an entry in `MACHINES` in `plugins/hardware/plugin.js` and a matching
process in its manifest.

### Buzz updates and releases

The [Buzz canary](canary/README.md) checks every day that the latest Buzz still
offers everything these plugins use; red on the release means do not update
Buzz yet. Work lands on `main`. People install from `stable`, which only Joey
moves, to a tested commit on `main`; installed plugins then offer **Update and
reload**. Until a release, try `main` with `BLACK4_BUZZ_REF=main` before the
`sh` in the commands above.

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
| `bridge/black4-mcp-bridge` | The process the plugin starts: `mcp-remote` in front of the Black 4 MCP. It owns the browser sign-in and token refresh; the plugin never reads credentials. |
| `bridge/black4-agent-mcp/` | The Black 4 MCP for agents that run on a Black 4 machine. `buzz-acp` starts it as the agent's MCP server; it signs every request with the agent's own Buzz key and owner attestation (`Authorization: Nostr`), so there is no sign-in. One pinned dependency, `@noble/curves`. |
| `machine/` | The machine side: `agentctl` (what the hardware plugin calls over SSH), `setup.sh` and `deploy.sh <ssh-host>`, which installs both on a machine, and `teammates.sh`, which adds a teammate's forced-command key. |
| `install.sh` | The install above: the Black 4 plugin, and with `--hardware` a teammate's machine key and SSH alias. |
| `tests/` | Unit tests against the plugin file, with a process double and fictional data. No sign-in or network. |
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

Buzz's `host.spawn` and process `write` are asynchronous. Initialization waits
for both. Reconnect and disable invalidate an older attempt and kill a process
that finishes spawning after it was superseded. Completed and cancelled calls
remove their abort listeners; write failures reject immediately.

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
`npm run test:subscriptions` runs the subscription plugins' own tests. To try a change in your own Buzz, copy
`plugins/black4/plugin.js` over the installed folder plugin, or install from
your branch, then use Buzz's `plugin_reload` tool and confirm with
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
