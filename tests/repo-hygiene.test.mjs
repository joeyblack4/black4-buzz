// What `npm run check` generates stays out of the repository: the Python
// tests write machine/**/__pycache__/*.pyc on every run, so a tracked copy
// would change under every check and land in every commit.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../", import.meta.url));

test("Python bytecode is ignored and none of it is tracked", () => {
  const ignored = readFileSync(`${root}.gitignore`, "utf8").split("\n").map((line) => line.trim());
  assert.ok(ignored.includes("__pycache__/"), ".gitignore lists __pycache__/");
  assert.ok(ignored.includes("*.pyc"), ".gitignore lists *.pyc");
  let tracked;
  try {
    tracked = execFileSync("git", ["ls-files", "--", "*.pyc", "**/__pycache__/*"], { cwd: root, encoding: "utf8" });
  } catch {
    return; // no git here: the ignore rules above are what can be checked
  }
  assert.equal(tracked.trim(), "", `tracked bytecode: ${tracked.trim()}`);
});
