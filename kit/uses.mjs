// What the Buzz UI kit takes from Buzz, found by drawing every part in every
// variant it takes (its VARIANTS). tests/kit.test.mjs requires the two to agree,
// so the list the Buzz canary checks is complete.
import { readFileSync } from "node:fs";

const kitSource = () => readFileSync(new URL("buzz-ui.js", import.meta.url), "utf8");

/** The kit as a function, loaded from its source. */
export function loadKit() {
  return new Function(`${kitSource()}\nreturn buzzUi;`)();
}

/** Just enough React to draw the kit: elements as objects, hooks as stubs. */
function drawingReact() {
  return {
    Fragment: "fragment",
    createElement: (type, props, ...children) => ({ type, props: { ...(props ?? {}), children: children.flat() } }),
    useState: (init) => [typeof init === "function" ? init() : init, () => {}],
    useRef: (current) => ({ current }),
    useId: () => "id",
    useEffect: () => {}, useLayoutEffect: () => {},
  };
}

/** Buzz's own component classes (its design-system stylesheets), as against Tailwind utilities. */
const COMPONENT = /^(buzz-|panel$|panel-header|navigation-item|navigation-card|inline-chip|notice$)/;

function walk(node, visit) {
  if (!node || typeof node !== "object") return;
  if (typeof node.type === "function") return walk(node.type(node.props), visit);
  visit(node);
  for (const child of node.props?.children ?? []) walk(child, visit);
}

/** { variants, classes, utilities, attributes, customProperties }: what the kit draws with. */
export function collect() {
  const React = drawingReact();
  const h = React.createElement;
  const variants = loadKit()(React).VARIANTS;
  const parts = [];
  for (const nativeSelect of [false, true]) {
    const ui = loadKit()(React, { nativeSelect });
    const options = [{ id: "a", label: "A", detail: "d" }, { id: "b", label: "B", unavailable: true }];
    parts.push(h(ui.SectionTitle, { title: "T", subtitle: "S" }));
    for (const layout of variants.Group.layout) parts.push(h(ui.Group, { layout }, h(ui.Row, { title: "R", description: "D", icon: "i", disabled: true, trailing: "x" })));
    parts.push(h(ui.Row, { title: "R", controlId: "c", trailing: () => "x" }));
    for (const variant of variants.Button.variant) for (const size of variants.Button.size) for (const shape of variants.Button.shape) {
      parts.push(h(ui.Button, { variant, size, shape }, "B"), h(ui.Button, { variant, size, shape, loading: true, href: "https://example.com" }, "B"));
    }
    for (const controlSize of variants.Input.controlSize) parts.push(h(ui.Input, { controlSize, width: "1rem" }));
    for (const checked of [true, false]) parts.push(h(ui.SwitchRow, { label: "S", checked, disabled: true, onCheckedChange: () => {} }));
    for (const shape of variants.Button.shape) for (const value of ["a", "none"]) parts.push(h(ui.Pill, { label: "P", value, options, onChange: () => {}, shape }));
    for (const error of [undefined, "E"]) parts.push(h(ui.TextField, { label: "L", description: "D", error, optional: true, value: "", onChange: () => {} }));
    for (const gap of variants.Stack.gap) parts.push(h(ui.Stack, { gap }, "x"));
    parts.push(h(ui.Actions, null, "x"), ui.Note("n"), ui.ErrorLine("e"), h(ui.Spinner), ui.Status("s"), ui.Value("v"), ui.Alert("a"), ui.Code("c"));
    for (const gap of variants.Column.gap) parts.push(h(ui.Column, { gap }, "x"));
    for (const level of variants.Header.level) parts.push(h(ui.Header, { title: "T", subtitle: "S", eyebrow: "E", actions: "a", level }));
    parts.push(h(ui.IconButton, { label: "L", glyph: "back", large: true, disabled: true }), h(ui.IconButton, { label: "L", glyph: "refresh" }));
    parts.push(h(ui.PanelHeader, { title: "T", navigation: "n", actions: ["a"] }), h(ui.Page, { label: "P", header: "h" }, "x"), h(ui.Page, { label: "P", fill: true }, "x"),
      h(ui.PanelBody, null, "x"), h(ui.Subview, { header: "h" }, "x"), h(ui.Fill, null, "x"), h(ui.Toolbar, null, "x"), h(ui.EmptyState, { glyph: "inbox", title: "T", description: "D", action: "a" }),
      h(ui.EmptyState, { title: "T", frame: "none" }), h(ui.NavItem, { label: "L", trailing: "t", selected: true, multiline: true }), h(ui.NavItem, { label: "L" }),
      h(ui.Tabs, { label: "L", value: "a", items: [{ value: "a", label: "A" }, { value: "b", label: "B" }], onChange() {} }),
      h(ui.Disclosure, { title: "T", defaultOpen: true }, "x"), h(ui.Disclosure, { title: "T" }, "x"),
      h(ui.CountBadge, { count: 3, label: "3" }), h(ui.Dot, { label: "L" }), h(ui.LinkChip, { label: "L" }),
      h(ui.CodeColumn, null, h(ui.OneTimeCode, { code: "AB12" })), h(ui.Failure, { message: "m", retry() {} }), h(ui.Notice, { title: "T" }, "x"),
      h(ui.Surface, { label: "S" }, "x"), h(ui.Subview, { header: "h", footer: "f" }, "x"), h(ui.Glyph, { name: "decisions" }),
      h(ui.ChipRow, null, h(ui.Chip, { label: "C", glyph: "money" }), h(ui.Chip, { label: "C" })),
      h(ui.DiffText, { label: "L", runs: [{ kind: "same", text: "a " }, { kind: "removed", text: "b" }, { kind: "added", text: "c" }] }), h(ui.DiffText, { runs: [] }),
      h(ui.ChangeTable, { rows: [{ label: "L", before: "a", after: "b", changed: true }, { label: "", before: "a", after: "a", changed: false }] }),
      h(ui.MediaPair, { before: "data:image/png;base64,", after: "data:image/png;base64," }), h(ui.MediaPair, { after: null, loading: true }),
      h(ui.DecisionBar, { status: "s" }, "x"), h(ui.DecisionBar, { stacked: true }, "x"), h(ui.DecisionBar, null),
      h(ui.Skeleton, { layout: "item" }), h(ui.Skeleton, { layout: "list" }),
      h(ui.Checkbox, { checked: true, label: "L", onCheckedChange() {} }), h(ui.Checkbox, { checked: false, size: "sm", disabled: true, label: "L", onCheckedChange() {} }),
      h(ui.ListGroup, { label: "L", count: 2 }, h(ui.SelectRow, { title: "T", subtitle: "S", meta: "2h", selected: true, picked: true, onPick() {}, onOpen() {} }),
        h(ui.SelectRow, { title: "T", quiet: true, onOpen() {} })),
      h(ui.Split, { label: "L", list: "l", detail: "d" }), h(ui.Frame, { label: "L" }, "x"), h(ui.Avatar, { name: "N", picture: "p", size: "small" }), h(ui.Avatar, { name: "N", size: "tiny", shape: "squircle", label: "L" }), h(ui.Avatar, { name: "N", size: "compact" }),
      h(ui.Byline, { avatar: "a", name: "N", app: "A", origin: "O", originGlyph: "clock" }), h(ui.Byline, { name: "N", origin: "O", originGlyph: "message", onOrigin() {} }),
      h(ui.Canvas, { label: "L", toolbar: ["t"] }, h(ui.CanvasImage, { src: "s", alt: "A" })), h(ui.CanvasImage, { alt: "A" }), h(ui.QuietLine, { glyph: "money" }, "q"), ui.Question("q"), ui.Permits("p"), h(ui.Article, { label: "L" }, "x"),
      h(ui.Tabs, { label: "L", value: "a", variant: "segmented", items: [{ value: "a", label: "A" }], onChange() {} }),
      h(ui.MessageCard, { label: "L" }, h(ui.MessageRow, { title: "T", subtitle: "S", onOpen() {} }), h(ui.MessageRow, { title: "T", loading: true })),
      ui.Title("t"), ui.Heading("h"), ui.Paragraph("p"), ui.Caption("c"), ui.Strong("s"), ui.Lines("a", "b"), ui.Line("l", { role: "status" }), ui.Line("l", { danger: true }), ui.Pre("p"));
    // The agent parts, with a pack avatar, a photo and no picture.
    const pack = ui.AVATARS[0].url;
    for (const picture of [pack, "https://example.com/a.png", undefined]) {
      parts.push(h(ui.AgentCard, { name: "N", picture, detail: "d", art: "i", badge: h(ui.CardMark, { label: "B", color: "red" }), menu: h(ui.Menu, { label: "M", items: [{ label: "A" }, { label: "D", tone: "danger" }] }), selected: true, unavailable: true }),
        h(ui.AgentProfile, { name: "N", picture, under: "u", actions: ["a"], editing: h(ui.NameInput, { value: "v", onChange() {}, invalid: true }) }, "x"));
    }
    for (const variant of ["glass-ghost", "glass", "subtle", "ghost"]) parts.push(h(ui.Menu, { label: "M", variant, items: [{ label: "A" }] }));
    parts.push(h(ui.AgentBrowse, { label: "L", art: "a", tabs: "t", action: "a", side: h(ui.AgentPanel, { name: "N", picture: pack, onClose() {} }, "x") }, h(ui.AgentGrid, { label: "G", busy: true }, "x")),
      h(ui.NameActions, null, "x"), h(ui.AvatarChoices, { value: pack, onChange() {} }), h(ui.HeaderTab, { label: "L", main: true }),
      h(ui.Picture, { src: "data:image/png;base64,", size: 16 }), h(ui.Glyph, { name: "robot" }));
  }
  const classes = new Set(), utilities = new Set(), attributes = new Set();
  for (const part of parts) walk(part, (node) => {
    const own = String(node.props.className ?? "").split(/\s+/).filter(Boolean);
    // Copied Buzz rules paint the kit's own `b4copy-` classes; the canary checks those rules.
    const copiedOnly = own.length > 0 && own.every((name) => name.startsWith("b4copy-"));
    for (const name of own) if (!name.startsWith("b4copy-")) (COMPONENT.test(name) ? classes : utilities).add(name);
    if (copiedOnly) return;
    // A bare element's attribute is checked wherever Buzz styles it.
    const owner = own.find((name) => COMPONENT.test(name)) ?? (own.length ? node.type : "*");
    for (const [key, value] of Object.entries(node.props)) {
      if (!key.startsWith("data-") || value === undefined || value === false || key === "data-value" || key === "data-tab-value") continue;
      attributes.add(value === "" || value === true ? `${owner}[${key}]` : `${owner}[${key}="${value}"]`);
    }
  });
  // Attributes the kit sets only while a menu is open, or at run time.
  const drawn = new Set([...attributes].map((entry) => entry.replace(/^[^[]*\[([^=\]]+).*$/, "$1")));
  for (const [, key] of kitSource().matchAll(/"(data-[\w-]+)"/g)) {
    if (!drawn.has(key) && key !== "data-value") attributes.add(`*[${key}]`);
  }
  // Buzz's custom properties the kit sets (the popup's) or reads (tokens in its inline styles).
  const customProperties = [...new Set([...kitSource().matchAll(/setProperty\("(--[\w-]+)"|var\((--[\w-]+)/g)].map((match) => match[1] ?? match[2]))];
  const sorted = (set) => [...set].sort();
  return { variants, classes: sorted(classes), utilities: sorted(utilities), attributes: sorted(attributes), customProperties: customProperties.sort() };
}
