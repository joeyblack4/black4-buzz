# Buzz UI kit

Status: current  
Owner: Black 4 platform  
Updated: 2026-11-18

Every screen a Black 4 plugin draws in Buzz should look like Buzz drew it.
[`buzz-ui.js`](buzz-ui.js) makes that the easy path. It holds Buzz's own
design-system primitives (`src/shared/design-system/ui` in
[block/buzz-app](https://github.com/block/buzz-app), built on v1.0.4 at
commit `a1c9c969`), drawn as plain elements with Buzz's classes, data
attributes and structure. Plugins render inside Buzz's React tree, so Buzz's
stylesheet paints them exactly as it paints its own screens. Buzz exposes no
components to plugins, so this markup is the only shared design system there
is.

## The rules

1. **Draw only with the kit.** Outside `buzz-ui.js`, plugin code writes no
   `className` and no `style`, and draws no raw `button`, `input`, `select`,
   `textarea` or `<style>`. If a screen needs something the kit lacks, add it
   to the kit, copied from Buzz's component of the same name. Don't style it
   in the plugin. `tests/kit.test.mjs` fails on any homemade UI in any
   plugin.
2. **Copy Buzz, don't approximate it.** A new part starts from Buzz's
   component source: the same element, classes, data attributes, nesting and
   accessible names, with its prop names. Use only Tailwind utilities that
   Buzz's own code uses. Tailwind writes only what Buzz's source contains, so
   a utility Buzz never uses does nothing in a plugin. The canary refuses one.
3. **Lay settings out the way Buzz's Settings screens are laid out.** Use a
   `SectionTitle` above a `Group` (the rounded card). Each `Row` has a title
   and an optional one-line description on the left, and its control on the
   right. Within a card, use `SwitchRow` for on and off, `Pill` for a choice
   and `Input` for short text. Use `TextField` below the cards for long text.
   Use `Stack` between sections and `Actions` for a row of buttons, with
   `prominent` for the one primary action.
4. **Use Buzz's words.** Say "Thinking", not "effort", and "Instructions", not
   "system prompt". Labels are short nouns. Descriptions are one plain line.
   Don't put explanatory paragraphs on a screen.
5. **Use colour only for meaning.** Red (`Alert`, `ErrorLine`) means broken.
   A wait is a `Status` spinner, not a warning colour.
6. **Show every setting.** Put no setting behind an "Advanced" section. If a
   choice matters, it gets a row.
7. **Check it on screen.** A test can't see the result. Before shipping a new
   or changed screen, put a screenshot of it next to Buzz's own Settings in
   light and dark.

## The parts

| Part | Buzz component | Use |
| --- | --- | --- |
| `SectionTitle` | `Header` (`InlineHeader`) | A section's title above its card. |
| `Group` | `SettingsGroup` | The rounded card. Every child is a row. |
| `Row` | `PreferenceRow` | Title, description, control on the right. |
| `SwitchRow` / `Switch` | `SwitchPreferenceRow` / `Switch` | On and off. |
| `Pill` | `Select` (compact) | A choice. Options: `{ id, label, detail?, unavailable? }`. |
| `Button` | `Button` | `variant` prominent, subtle, outline, destructive, ghost or link; `size` sm, md or text; `shape` capsule or control; `loading`; `href` for links. |
| `Input` | `Input` | Short text; `controlSize`, `width`. |
| `TextField` | `Field` + `Textarea` | Long text with a label, description and error. |
| `Stack`, `Actions` | Buzz's Settings layout | Space between sections (`gap` 4) or fields (`gap` 2), and a row of buttons. |
| `Note`, `ErrorLine`, `Status`, `Spinner`, `Value`, `Alert`, `Code` | Buzz's own lines | A muted note, an error, progress, a read-only value, a broken state and a code. |
| `Header` | `Header` | A settings card's or page's title, with eyebrow, subtitle and actions (GitHub's, Claude's cards). |
| `Column` | Builderlab's sign-in | Lines and one button, left-aligned. |
| `PanelHeader`, `IconButton` | `PanelHeader`, `IconButton` (ghost) | A page's or drill-in's bar: back, title, actions. Also a channel launcher. |
| `Page`, `Subview`, `PanelBody`, `Toolbar`, `Fill` | `Panel` and Shared notes' page; `PanelSubview` | A dock page's surface; a drill-in whose bar stays put; a panel's inset body; a bar above a body; an embedded browser's space. |
| `NavItem`, `CountBadge`, `Dot` | `NavigationItem`, `CountBadge`, Activity's unread dot | A row that opens something; a count; something waiting without a count. |
| `EmptyState`, `Failure`, `Notice` | `EmptyState`, relay-staff's failure, `.notice` | Nothing here; something broke (with Retry); something needs a person. |
| `Tabs`, `Disclosure` | `Tabs` (panel), `Accordion` (form) | Pick one of a few items; a section that opens. |
| `OneTimeCode`, `CodeColumn` | Pairing's code | A code to confirm elsewhere, with its Copy button. |
| `LinkChip` | `InlineChip` (link) | A link renderer's chip in a message. |
| `Chip`, `ChipRow`, `Glyph` | `ValueChip` | A short read-only value (a stake, a fact), with an optional 12px mark; one icon alone. |
| `DiffText` | Diffs' card and insert/delete fills (`bundled/diffs`) | A word diff: added words on the insert tint, removed words struck through on the delete tint. Never red text. |
| `ChangeTable` | Diffs' card | Fields before and after: each row's label, Now and After; unchanged rows read once, quietly. |
| `MediaPair`, `Frame` | Diffs' card and `.preview` | Before and after images; the finished work as a page in a bounded frame. |
| `DecisionBar` | Activity's toolbar border, at the bottom | The bar under a panel's body: a status line, then the actions. |
| `Skeleton` | (Buzz has none) inset bars in the real layout | Loading, without a spinner in place of the content. |
| `Checkbox` | `Checkbox` | A checkbox the row names. |
| `SelectRow`, `ListGroup`, `Split` | Activity's `MessageListRow` in a `NavigationCard`; Inbox's workspace | A list row with an optional Checkbox beside it; a titled list; the list beside the preview. |
| `MessageCard`, `MessageRow`, `Surface` | Diffs' `DiffMessage` card | One card under a message, its rows; a panel surface that knows it has focus. |
| `Title`, `Heading`, `Paragraph`, `Caption`, `Strong`, `Lines`, `Line`, `Pre` | Buzz's type roles | Page title, section heading, body, muted small text, a row's emphasised line, stacked lines, a status or alert line, pre-formatted text. |
| `AgentBrowse`, `AgentGrid`, `AgentCard`, `CardMark` | Agents page (`AgentsPage`, `AgentCard`, the Bestie mark) | A page of agents laid out as Buzz's Agents page: header tab, tabs, the card grid, a mark on a card. |
| `AgentPanel`, `AgentProfile`, `NameInput`, `NameActions`, `AvatarChoices` | The agent panel (`PanelWorkspace`, `AgentDetails`, Change avatar's packs) | An open agent beside the grid: its hero, name editor and avatar choices. |
| `AgentPortrait`, `Menu`, `HeaderTab`, `Picture`, `Glyph` | `AgentPortrait`, `Menu`, navigation `Tabs`, an icon | An agent's picture (pack avatars play); a "…" menu; a panel header's tab; a logo; a glyph. |

A part takes only variants Buzz styles (`VARIANTS` in the kit). Anything else
draws the default, never an unstyled control.

Pass `{ nativeSelect: true }` to draw dropdowns as the same pill over the
system's own menu, in case Buzz's popup ever misbehaves in a webview.

### Buzz's own rules, copied

Buzz draws its agent cards and profile with CSS-module classes, which it
renames on every build, so a plugin cannot use them. For those parts the kit
carries Buzz's own rules, word for word, under its own class names
(`b4copy-<file>-<class>`), along with Buzz's avatar packs.
[`copy.mjs`](copy.mjs) lists what is taken from which Buzz file and writes it
into `buzz-ui.js` (`node kit/copy.mjs <block/buzz-app checkout>`, then
`npm run kit`). Change that list, never the copied text. The canary checks
every copied rule and avatar against Buzz each day.

## Using it in a plugin

Buzz runs no build, so each plugin carries its own copy of the kit between two
marker lines:

```js
// ---- buzz-ui kit: stamped from kit/buzz-ui.js by `npm run kit`; edit it there ----
// ---- end buzz-ui kit ----
```

Put the markers in the plugin (or, for the subscription plugins, in
`subscriptions/src/common.js`) and add the file to `STAMPED` in
[`build.mjs`](build.mjs). Run `npm run kit`, then
`const { Group, Row, Pill } = buzzUi(React)`. Edit the kit only in
`kit/buzz-ui.js`. `npm run check` refuses a stale copy.

## When Buzz changes

[`uses.json`](uses.json) lists every Buzz class, data attribute, Tailwind
utility and custom property the kit draws with. A test keeps it complete.
Every day the [Buzz canary](../canary/README.md) (`canary/design.mjs`) checks
each entry against the latest Buzz release, the newest preview and `main`. A
red **Design** step names the entry Buzz dropped. Read how Buzz draws that part
now, change `buzz-ui.js` and `uses.json` to match, run `npm run kit`, and look
at the screen again.

The canary checks names, not pixels. If Buzz restyles a class it kept, the
canary stays green, and our screens change with Buzz's, which is the point.
