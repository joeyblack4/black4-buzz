// What the Buzz UI kit takes from Buzz, found by drawing every part in every
// variant kit/uses.json allows. tests/kit.test.mjs requires the two to agree,
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

function walk(node, visit) {
  if (!node || typeof node !== "object") return;
  if (typeof node.type === "function") return walk(node.type(node.props), visit);
  visit(node);
  for (const child of node.props?.children ?? []) walk(child, visit);
}

/** { classes, utilities, attributes, customProperties } the kit draws with
 * the variants in `variants` (kit/uses.json's). */
export function collect(variants) {
  const React = drawingReact();
  const h = React.createElement;
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
  }
  const classes = new Set(), utilities = new Set(), attributes = new Set();
  for (const part of parts) walk(part, (node) => {
    const own = String(node.props.className ?? "").split(/\s+/).filter(Boolean);
    for (const name of own) (name.startsWith("buzz-") ? classes : utilities).add(name);
    const owner = own.find((name) => name.startsWith("buzz-")) ?? node.type;
    for (const [key, value] of Object.entries(node.props)) {
      if (!key.startsWith("data-") || value === undefined || value === false || key === "data-value") continue;
      attributes.add(value === "" || value === true ? `${owner}[${key}]` : `${owner}[${key}="${value}"]`);
    }
  });
  // Attributes the kit sets only while a menu is open, or at run time.
  const drawn = new Set([...attributes].map((entry) => entry.replace(/^[^[]*\[([^=\]]+).*$/, "$1")));
  for (const [, key] of kitSource().matchAll(/"(data-[\w-]+)"/g)) {
    if (!drawn.has(key) && key !== "data-value") attributes.add(`*[${key}]`);
  }
  const customProperties = [...new Set([...kitSource().matchAll(/setProperty\("(--[\w-]+)"/g)].map((match) => match[1]))];
  const sorted = (set) => [...set].sort();
  return { classes: sorted(classes), utilities: sorted(utilities), attributes: sorted(attributes), customProperties: customProperties.sort() };
}
