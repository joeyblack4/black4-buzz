// The Buzz UI kit is the one way a Black 4 plugin draws: every plugin's
// copy is current, kit/uses.json (what the Buzz canary checks) lists all of
// what the kit takes from Buzz, and no plugin draws a new control of its own.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { BEGIN, END, STAMPED, stamp } from "../kit/build.mjs";
import { collect, loadKit } from "../kit/uses.mjs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const uses = JSON.parse(read("kit/uses.json"));
const ceilings = JSON.parse(read("kit/homemade.json"));
/** A className or style, or a raw control or <style>, drawn outside the kit. */
const HOMEMADE = /\bclassName\s*:|\bstyle\s*:|\bh\(\s*["'](?:button|input|select|textarea|style)["']/g;
/** Plugins built from subscriptions/src: their sources are what people edit. */
const BUILT = new Set(["claude-subscription", "grok-subscription"]);

function sources() {
  const out = [];
  for (const dir of readdirSync(new URL("../plugins", import.meta.url))) {
    if (!BUILT.has(dir)) out.push(`plugins/${dir}/plugin.js`);
  }
  for (const name of readdirSync(new URL("../subscriptions/src", import.meta.url))) out.push(`subscriptions/src/${name}`);
  return out;
}
const outsideKit = (text) => {
  const begin = text.indexOf(BEGIN);
  return begin < 0 ? text : text.slice(0, begin) + text.slice(text.indexOf(END, begin));
};

test("kit: every stamped plugin holds the current kit", () => {
  const kit = read("kit/buzz-ui.js");
  let stamped = 0;
  for (const file of STAMPED) {
    const text = read(file);
    const next = stamp(text, kit);
    if (next === null) continue;
    stamped++;
    assert.equal(next, text, `${file} holds an old copy of the kit: run npm run kit`);
  }
  assert.ok(stamped >= 1, "the Black 4 plugin carries the kit");
  for (const file of sources()) {
    if (read(file).includes(BEGIN)) assert.ok(STAMPED.includes(file), `${file} carries the kit markers but kit/build.mjs does not stamp it: add it to STAMPED`);
  }
});

test("kit: kit/uses.json lists exactly what the kit draws with, so the canary checks all of it", () => {
  const drawn = collect(uses.variants);
  for (const key of ["classes", "utilities", "attributes", "customProperties"]) {
    assert.deepEqual(uses[key], drawn[key], `kit/uses.json "${key}" is out of date. It should be:\n${JSON.stringify(drawn[key], null, 2)}`);
  }
});

test("kit: each part draws with Buzz's classes, and Pill draws Buzz's popup or the native select", () => {
  const React = { Fragment: "f", createElement: (type, props, ...children) => ({ type, props: { ...(props ?? {}), children: children.flat() } }),
    useState: (v) => [v, () => {}], useRef: (current) => ({ current }), useId: () => "id", useEffect() {}, useLayoutEffect() {} };
  const ui = loadKit()(React);
  assert.deepEqual(Object.keys(ui).sort(), ["Actions", "Alert", "Button", "Code", "ErrorLine", "Group", "Input", "Native", "Note", "Pill", "Popup",
    "Row", "SectionTitle", "Spinner", "Stack", "Status", "Switch", "SwitchRow", "TextField", "Value"]);
  assert.equal(ui.Pill, ui.Popup);
  assert.equal(loadKit()(React, { nativeSelect: true }).Pill.name, "Native");
  assert.deepEqual(ui.Input({ width: "11rem" }).props.style, { width: "11rem" });
  assert.equal(ui.Stack({ as: "form", gap: 2, children: ["a"] }).type, "form");
});

test("kit: no plugin draws more of its own UI than before; new screens use the kit", () => {
  for (const file of sources()) {
    const found = (outsideKit(read(file)).match(HOMEMADE) ?? []).length;
    const ceiling = ceilings[file] ?? 0;
    assert.ok(found <= ceiling, `${file} draws ${found} things of its own (a className, a style, or a raw button, input, select, textarea or <style>); at most ${ceiling} may remain from before the kit. Draw with the Buzz UI kit (kit/README.md) instead.`);
    assert.ok(found === ceiling, `${file} now draws only ${found} things of its own: lower its number in kit/homemade.json to ${found}, so it cannot grow back.`);
  }
  for (const file of Object.keys(ceilings)) if (!file.startsWith("$")) assert.ok(sources().includes(file), `kit/homemade.json lists ${file}, which is gone`);
});

test("kit: Black 4 hardware, after the kit, draws nothing of its own", () => {
  const text = read("plugins/black4/plugin.js");
  assert.equal((text.slice(text.indexOf(END)).match(HOMEMADE) ?? []).length, 0);
});
