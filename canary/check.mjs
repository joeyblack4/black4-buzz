#!/usr/bin/env node
// Black 4 Buzz canary: does a given Buzz (block/buzz-app) checkout still offer
// everything Black 4's plugins use?
//
//   node canary/check.mjs <path to a block/buzz-app checkout> [--label v1.0.3]
//
// It reads Buzz's own TypeScript types with the TypeScript compiler (installed
// only under canary/: `npm ci --prefix canary`) and Buzz's Rust manifest
// schema, and checks every entry of canary/contract.json against them. Buzz's
// own dependencies are not needed. Exit 0: compatible. Exit 1: something the
// plugins use changed; each problem is printed as one sentence. Exit 2: the
// canary itself could not run (bad path, Buzz moved its sources).
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const require = createRequire(import.meta.url);

function usage(message) {
  if (message) console.error(message);
  console.error("Usage: node canary/check.mjs <block/buzz-app checkout> [--label <name>]");
  process.exit(2);
}

const args = process.argv.slice(2);
const labelAt = args.indexOf("--label");
let label = labelAt >= 0 ? args.splice(labelAt, 2)[1] : undefined;
const buzz = args[0] ? resolve(args[0]) : usage();
if (!existsSync(join(buzz, "src/plugins/api.ts"))) {
  usage(`${buzz} does not look like a block/buzz-app checkout (no src/plugins/api.ts). If Buzz moved its plugin API, the canary needs updating.`);
}
label ??= gitLabel(buzz) ?? relative(process.cwd(), buzz);

let ts;
try {
  ts = require("typescript");
} catch {
  usage("The canary's TypeScript is not installed. Run: npm ci --prefix canary");
}

const contract = JSON.parse(readFileSync(join(here, "contract.json"), "utf8"));
const problems = []; // one plain sentence each
const notes = []; // could not verify, but not a break
let checks = 0;

// ---- 1. The envelope libraries -------------------------------------------
const buzzPackage = JSON.parse(readFileSync(join(buzz, "package.json"), "utf8"));
const buzzDeps = { ...buzzPackage.dependencies, ...buzzPackage.devDependencies };
for (const [name, expected] of Object.entries(contract.envelope)) {
  if (name.startsWith("$")) continue;
  checks++;
  const actual = String(buzzDeps[name] ?? "").replace(/^[\^~]/, "");
  if (!actual) problems.push(`Every plugin: Buzz ${label} no longer depends on ${name}, which the plugin envelope (ctx, ctx.effect, React components) is built on.`);
  else if (!(actual === expected || actual.startsWith(`${expected}.`))) {
    problems.push(`Every plugin: Buzz ${label} moved ${name} from ${expected} to ${actual}. The plugin envelope may have changed; read its changelog, then update canary/package.json and contract.json "envelope" and run the canary again.`);
  }
}

// ---- 2. Buzz's TypeScript types --------------------------------------------
const modules = join(here, "node_modules");
const roots = [join(buzz, "src/plugins/author.ts")];
for (const file of walk(join(buzz, "src"))) {
  if (!/\.tsx?$/.test(file) || /\.test\.tsx?$/.test(file) || file.endsWith(".d.ts")) continue;
  if (/declare module "@deepseek-ai\/cordis"/.test(readFileSync(file, "utf8"))) roots.push(file);
}
const program = ts.createProgram([...new Set(roots)], {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  jsx: ts.JsxEmit.ReactJSX,
  strict: true,
  exactOptionalPropertyTypes: true,
  noEmit: true,
  skipLibCheck: true,
  allowImportingTsExtensions: true,
  resolveJsonModule: true,
  types: [],
  lib: ["lib.es2022.d.ts", "lib.dom.d.ts", "lib.dom.iterable.d.ts"],
  // Only the libraries the plugin envelope is typed with; anything else Buzz
  // imports resolves to nothing, which is fine for reading its own types.
  paths: {
    react: [join(modules, "@types/react/index.d.ts")],
    "react/*": [join(modules, "@types/react/*")],
    "@deepseek-ai/cordis": [join(modules, "@deepseek-ai/cordis/lib/types/index.d.ts")],
  },
});
const checker = program.getTypeChecker();

const cordisFile = program.getSourceFiles().find((file) => file.fileName.includes("@deepseek-ai/cordis/lib/types/context.d.ts"));
const contextNode = cordisFile?.statements.find((node) => node.name?.text === "Context");
if (!contextNode) usage("Could not find cordis's Context type. Run: npm ci --prefix canary");
const Context = checker.getDeclaredTypeOfSymbol(checker.getSymbolAtLocation(contextNode.name));

const authorFile = program.getSourceFile(join(buzz, "src/plugins/author.ts"));
const authorExports = new Map(checker.getExportsOfModule(checker.getSymbolAtLocation(authorFile)).map((symbol) => [symbol.name, symbol]));
const manifestSymbol = authorExports.get("PluginManifest");
let PluginManifest;
if (manifestSymbol) {
  const target = manifestSymbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(manifestSymbol) : manifestSymbol;
  PluginManifest = checker.getDeclaredTypeOfSymbol(target);
} else problems.push(`Every plugin: Buzz ${label}'s author types (src/plugins/author.ts) no longer export PluginManifest, the manifest type.`);

// ---- 3. Buzz's manifest schema (Rust, serde) ------------------------------
const rust = rustStructs(join(buzz, "crates/plugin-manager/src"));
if (!rust.has("Manifest")) problems.push(`Every plugin: Buzz ${label} no longer defines its manifest schema as struct Manifest in crates/plugin-manager/src, so the canary cannot tell whether it still accepts the plugin manifests.`);
const apiVersions = [...readRust(join(buzz, "crates/plugin-manager/src")).matchAll(/api_version\s*!=\s*(\d+)/g)].map((match) => Number(match[1]));

// ---- 4. Each plugin ---------------------------------------------------------
const plugins = contract.plugins;
for (const [id, raw] of Object.entries(plugins)) {
  const spec = raw.sameAs ? { ...plugins[raw.sameAs], ...raw } : raw;
  const who = `${spec.title} (${id})`;
  const fail = (sentence) => problems.push(`${who}: ${sentence}`);

  for (const service of spec.inject ?? []) {
    checks++;
    if (!checker.getPropertyOfType(Context, service)) fail(`it injects the "${service}" service, which Buzz ${label} no longer declares on ctx. Buzz would never start the plugin.`);
  }

  for (const path of spec.uses ?? []) {
    checks++;
    const found = walkPath(path);
    if (found.error) fail(`it uses ${show(path)}, but ${found.error}`);
    else if (found.opaque) notes.push(`${who}: ${show(path)} could not be verified past ${show(found.opaque)} (Buzz types it loosely).`);
  }

  for (const [path, keys] of Object.entries(spec.provides ?? {})) {
    checks++;
    const found = walkPath(path);
    if (found.error) { fail(`it gives Buzz ${show(path)}, but ${found.error}`); continue; }
    if (found.opaque) { notes.push(`${who}: the keys of ${show(path)} could not be verified (Buzz types it loosely).`); continue; }
    const error = providedKeys(found.type, keys);
    if (error) fail(`it gives Buzz ${show(path)} with ${keys.map((key) => `"${key}"`).join(", ")}, but ${error}`);
  }

  for (const [path, value] of Object.entries(spec.accepts ?? {})) {
    checks++;
    const found = walkPath(path);
    if (found.error) { fail(`it passes ${JSON.stringify(value)} as ${show(path)}, but ${found.error}`); continue; }
    if (found.opaque) continue;
    const literal = typeof value === "number" ? checker.getNumberLiteralType(value) : checker.getStringLiteralType(String(value));
    if (!checker.isTypeAssignableTo(literal, found.type)) {
      fail(`it passes ${JSON.stringify(value)} as ${show(path)}, which Buzz ${label} no longer allows (it now takes ${checker.typeToString(found.type)}).`);
    }
  }

  // The manifest: the contract must list every key the real manifest has,
  // and Buzz's TypeScript type and Rust schema must both still know them.
  const manifest = JSON.parse(readFileSync(join(here, "..", spec.dir, "manifest.json"), "utf8"));
  const listed = new Set(spec.manifest);
  for (const key of manifestKeys(manifest)) {
    if (!listed.has(key)) fail(`its manifest.json has "${key}", which canary/contract.json does not list. Add it there.`);
  }
  for (const key of spec.manifest) {
    checks++;
    if (PluginManifest) {
      const found = walkType(PluginManifest, tokens(key), "manifest");
      if (found.error) fail(`its manifest.json sets "${key}", but Buzz ${label}'s PluginManifest type ${found.error.replace(/^Buzz \S+ /, "")}`);
    }
    if (rust.has("Manifest")) {
      const error = rustPath(key);
      if (error) fail(`its manifest.json sets "${key}", but ${error}`);
    }
  }
  checks++;
  if (PluginManifest) {
    const found = walkType(PluginManifest, tokens("apiVersion"), "manifest");
    if (!found.error && !found.opaque && !checker.isTypeAssignableTo(checker.getNumberLiteralType(manifest.apiVersion), found.type)) {
      fail(`its manifest says apiVersion ${manifest.apiVersion}, which Buzz ${label}'s PluginManifest type no longer allows (it takes ${checker.typeToString(found.type)}).`);
    }
  }
  if (apiVersions.length && !apiVersions.includes(manifest.apiVersion)) {
    fail(`its manifest says apiVersion ${manifest.apiVersion}, but Buzz ${label} only loads plugins with apiVersion ${apiVersions.join(" or ")}.`);
  }
}

// ---- 5. Report --------------------------------------------------------------
const pluginCount = Object.keys(plugins).length;
if (problems.length) {
  console.error(`Buzz ${label} BREAKS Black 4's plugins (${problems.length} of ${checks} checks failed):\n`);
  for (const problem of problems) console.error(`- ${problem}`);
  if (notes.length) console.error(`\nAlso not verifiable:\n${notes.map((note) => `- ${note}`).join("\n")}`);
  console.error("\nDo not update Buzz until each plugin is fixed for this version. See canary/README.md.");
  process.exit(1);
}
console.log(`Buzz ${label} is compatible: ${checks} checks pass for ${pluginCount} plugins.`);
if (notes.length) console.log(`Not verifiable from the types:\n${notes.map((note) => `- ${note}`).join("\n")}`);

// ---- helpers ----------------------------------------------------------------

/** `a.b(1)=>.c[]` as tokens: { prop }, { arg }, { returns }, { element }. */
function tokens(path) {
  const out = [];
  const pattern = /\.?([A-Za-z_$][\w$]*)|\((\d+)\)|(=>)|(\[\])/gy;
  let match;
  while (pattern.lastIndex < path.length && (match = pattern.exec(path))) {
    if (match[1]) out.push({ prop: match[1] });
    else if (match[2]) out.push({ arg: Number(match[2]) });
    else if (match[3]) out.push({ returns: true });
    else out.push({ element: true });
  }
  if (pattern.lastIndex !== path.length) throw new Error(`contract.json: cannot read path "${path}"`);
  return out;
}

/** How a path reads in a sentence: ctx.agents.register(…).remote.provision(…).signal */
function show(path, prefix = "ctx.") {
  return prefix + path.replace(/\((\d+)\)/g, "(…)").replace(/=>/g, "(…)").replace(/\[\]/g, "[i]").replace(/\(…\)\(…\)/g, "(…)");
}

function walkPath(path) {
  return walkType(Context, tokens(path), "ctx");
}

/** Follows `steps` from `type`. Resolves { type }, { opaque } when it reaches
 * a type too loose to look into (any/unknown), or { error } as a sentence end. */
function walkType(type, steps, root) {
  let current = type;
  const done = [];
  const where = () => {
    if (!done.length) return root;
    const text = `${root}.${pathText(done)}`;
    if (done.at(-1).returns) return `what ${text} returns`;
    if (done.at(-1).arg !== undefined) return `what Buzz passes as ${text}`;
    return text;
  };
  for (const step of steps) {
    if (isLoose(current)) return { opaque: pathText(done) || root };
    const base = checker.getNonNullableType(current);
    if (step.prop) {
      const found = [];
      for (const part of parts(base)) {
        const symbol = checker.getPropertyOfType(part, step.prop);
        if (symbol) found.push(checker.getTypeOfSymbol(symbol));
        else if (checker.getIndexInfosOfType(part).some((info) => info.keyType.flags & ts.TypeFlags.String)) found.push(checker.getIndexInfosOfType(part)[0].type);
      }
      if (!found.length) return { error: `Buzz ${label} no longer has "${step.prop}" on ${where()}.` };
      current = found.length === 1 ? found[0] : checker.getUnionType(found);
    } else if (step.arg !== undefined || step.returns) {
      const signatures = parts(base).flatMap((part) => checker.getSignaturesOfType(part, ts.SignatureKind.Call));
      if (!signatures.length) return { error: `in Buzz ${label} ${where()} is no longer something it can call.` };
      if (step.returns) {
        current = checker.getUnionType(signatures.map((signature) => checker.getAwaitedType(checker.getReturnTypeOfSignature(signature)) ?? checker.getReturnTypeOfSignature(signature)));
      } else {
        const params = signatures.map((signature) => paramType(signature, step.arg)).filter(Boolean);
        if (!params.length) return { error: `in Buzz ${label} ${where()} no longer takes an argument ${step.arg + 1}.` };
        current = params.length === 1 ? params[0] : checker.getUnionType(params);
      }
    } else if (step.element) {
      const element = parts(base).map((part) => checker.getIndexTypeOfType(part, ts.IndexKind.Number)).filter(Boolean);
      if (!element.length) return { error: `in Buzz ${label} ${where()} is no longer a list.` };
      current = element.length === 1 ? element[0] : checker.getUnionType(element);
    }
    done.push(step);
  }
  return { type: current };
}

function pathText(steps) {
  return steps.map((step) => (step.prop ? `.${step.prop}` : step.element ? "[i]" : "(…)")).join("").replace(/^\./, "");
}

function paramType(signature, index) {
  const params = signature.getParameters();
  if (index < params.length) {
    const declaration = params[index].valueDeclaration;
    const type = checker.getTypeOfSymbol(params[index]);
    if (declaration?.dotDotDotToken) return checker.getIndexTypeOfType(type, ts.IndexKind.Number) ?? type;
    return type;
  }
  const last = params.at(-1)?.valueDeclaration;
  if (last?.dotDotDotToken) return checker.getIndexTypeOfType(checker.getTypeOfSymbol(params.at(-1)), ts.IndexKind.Number);
  return undefined;
}

function parts(type) {
  return type.isUnion() ? type.types : [type];
}

function isLoose(type) {
  return Boolean(type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown));
}

/** Whether an object with exactly `keys` still fits `type` (one member of a
 * union is enough): every key is known, and every required key is given. */
function providedKeys(type, keys) {
  const base = checker.getNonNullableType(type);
  let best;
  for (const part of parts(base)) {
    const open = checker.getIndexInfosOfType(part).some((info) => info.keyType.flags & ts.TypeFlags.String);
    const unknown = open ? [] : keys.filter((key) => !checker.getPropertyOfType(part, key));
    const required = checker.getPropertiesOfType(part)
      .filter((symbol) => !(symbol.flags & ts.SymbolFlags.Optional) && !keys.includes(symbol.name))
      .map((symbol) => symbol.name);
    if (!unknown.length && !required.length) return undefined;
    const sentence = [
      unknown.length ? `Buzz ${label} no longer reads ${list(unknown)} there` : "",
      required.length ? `Buzz ${label} now also requires ${list(required)}, which the plugin does not give` : "",
    ].filter(Boolean).join(", and ") + ".";
    if (!best || unknown.length + required.length < best.count) best = { sentence, count: unknown.length + required.length };
  }
  return best?.sentence;
}

function list(names) {
  return names.map((name) => `"${name}"`).join(", ");
}

/** Every key path in a manifest, in contract syntax: host.processes[].args */
function manifestKeys(value, prefix = "") {
  const out = new Set();
  if (Array.isArray(value)) {
    for (const item of value) {
      if (item && typeof item === "object") for (const key of manifestKeys(item, `${prefix}[]`)) out.add(key);
    }
  } else if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      const path = prefix ? `${prefix}.${key}` : key;
      const nested = child && typeof child === "object" && !(Array.isArray(child) && child.every((item) => typeof item !== "object"));
      if (nested) for (const sub of manifestKeys(child, path)) out.add(sub);
      else out.add(path);
    }
  }
  return out;
}

/** Buzz's serde structs: name -> { strict, fields: Map(jsonName -> inner type) }. */
function rustStructs(dir) {
  const structs = new Map();
  const source = readRust(dir);
  const pattern = /((?:#\[[^\]]*\]\s*)*)pub struct (\w+)\s*\{([\s\S]*?)\n\}/g;
  for (const [, attributes, name, body] of source.matchAll(pattern)) {
    const camel = /rename_all\s*=\s*"camelCase"/.test(attributes);
    const strict = /deny_unknown_fields/.test(attributes);
    const fields = new Map();
    const field = /((?:#\[[^\]]*\]\s*|\/\/\/[^\n]*\n\s*)*)pub (\w+)\s*:\s*([^,\n]+),/g;
    for (const [, fieldAttributes, fieldName, fieldType] of body.matchAll(field)) {
      const renamed = fieldAttributes.match(/rename\s*=\s*"([^"]+)"/)?.[1];
      const json = renamed ?? (camel ? fieldName.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase()) : fieldName);
      let inner = fieldType.trim();
      for (;;) {
        const wrapped = inner.match(/^(?:Option|Vec|Box)<(.+)>$/);
        if (!wrapped) break;
        inner = wrapped[1].trim();
      }
      fields.set(json, inner);
    }
    if (!structs.has(name)) structs.set(name, { strict, fields });
  }
  return structs;
}

function rustPath(key) {
  let struct = "Manifest";
  const segments = key.replace(/\[\]/g, "").split(".");
  for (const [index, segment] of segments.entries()) {
    const shape = rust.get(struct);
    if (!shape) return undefined; // a plain value or a type the canary cannot read
    const inner = shape.fields.get(segment);
    const at = segments.slice(0, index).join(".") || "the top level";
    if (!inner) {
      return shape.strict
        ? `Buzz ${label} no longer accepts "${segment}" in ${at} of a manifest (struct ${struct} refuses unknown keys), so it would refuse to install or load the plugin.`
        : undefined;
    }
    struct = inner;
  }
  return undefined;
}

function readRust(dir) {
  if (!existsSync(dir)) return "";
  return walk(dir).filter((file) => file.endsWith(".rs") && !/tests?\.rs$/.test(file)).map((file) => readFileSync(file, "utf8")).join("\n");
}

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...walk(path));
    else out.push(path);
  }
  return out;
}

function gitLabel(dir) {
  try {
    return execFileSync("git", ["-C", dir, "describe", "--tags", "--always"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return undefined;
  }
}
