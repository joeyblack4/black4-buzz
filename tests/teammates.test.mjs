// Teammate access to a Black 4 machine: machine/teammates.sh (the admin's side,
// run against a temporary authorized_keys) and install.sh --hardware (the
// teammate's side, run against a temporary ~/.ssh). Nothing reaches a machine.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const root = new URL("..", import.meta.url).pathname;
const sshKeygen = spawnSync("ssh-keygen", ["-?"]).error ? null : "ssh-keygen";
const temp = () => mkdtempSync(join(tmpdir(), "black4-teammates-"));
function newKey(dir, name) {
  execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", `${name}@example.test`, "-f", join(dir, name)]);
  return readFileSync(join(dir, `${name}.pub`), "utf8").trim();
}
const admin = (file, home, ...args) => spawnSync("sh", [join(root, "machine/teammates.sh"), ...args], {
  env: { ...process.env, AUTHORIZED_KEYS: file, HOME: home }, encoding: "utf8",
});

test("add writes one forced-command line, list shows it, remove takes only it out", { skip: !sshKeygen }, () => {
  const dir = temp();
  const file = join(dir, "ssh", "authorized_keys");
  const own = newKey(dir, "admin");
  const chris = newKey(dir, "chris");
  const dave = newKey(dir, "dave");
  execFileSync("mkdir", ["-p", join(dir, "ssh")]);
  writeFileSync(file, `${own}\n`);

  const added = admin(file, "/Users/machine", "add", "chris", chris);
  assert.equal(added.status, 0, added.stderr);
  assert.equal(admin(file, "/Users/machine", "add", "dave", dave).status, 0);
  const lines = readFileSync(file, "utf8").trim().split("\n");
  assert.equal(lines[0], own, "existing lines are kept as they were");
  const [type, blob] = chris.split(" ");
  assert.equal(lines[1], `command="/Users/machine/workforce/bin/agentctl --caller chris",restrict,no-port-forwarding,no-agent-forwarding,no-pty,no-X11-forwarding,no-user-rc ${type} ${blob} black4-teammate:chris`);
  assert.equal(statSync(file).mode & 0o777, 0o600);

  const listed = admin(file, "/Users/machine", "list");
  assert.equal(listed.status, 0, listed.stderr);
  assert.deepEqual(listed.stdout.trim().split("\n").map((row) => row.split("\t")[0]), ["chris", "dave"]);
  assert.match(listed.stdout, /SHA256:/);

  assert.notEqual(admin(file, "/Users/machine", "add", "chris", dave).status, 0, "one key per label");
  assert.notEqual(admin(file, "/Users/machine", "add", "eve", own).status, 0, "a key already here, unrestricted, is not added again");

  assert.equal(admin(file, "/Users/machine", "remove", "chris").status, 0);
  const after = readFileSync(file, "utf8").trim().split("\n");
  assert.deepEqual(after.map((line) => line.split(" ").at(-1)), [own.split(" ").at(-1), "black4-teammate:dave"]);
  assert.notEqual(admin(file, "/Users/machine", "remove", "chris").status, 0);
  assert.ok(existsSync(`${file}.black4-previous`));
});

test("add refuses labels and keys that are not what they claim", { skip: !sshKeygen }, () => {
  const dir = temp();
  const file = join(dir, "authorized_keys");
  const key = newKey(dir, "k");
  for (const [label, line] of [
    ["Chris", key], ["a b", key], ["chris;rm", key], ["", key],
    ["chris", "ssh-ed25519 AAAA"], ["chris", "not-a-key AAAAC3NzaC1lZDI1NTE5AAAAI"], ["chris", `command="sh" ${key}`],
  ]) {
    const result = admin(file, dir, "add", label, line);
    assert.notEqual(result.status, 0, `${label} / ${line}`);
  }
  assert.ok(!existsSync(file) || readFileSync(file, "utf8") === "");
});

const install = (sshDir, ...args) => spawnSync("sh", [join(root, "install.sh"), ...args], {
  env: { ...process.env, BLACK4_SSH_DIR: sshDir, BLACK4_NO_OPEN: "1" }, encoding: "utf8",
});

test("install.sh --hardware makes a dedicated key, the alias, and prints the one line to send", { skip: !sshKeygen }, () => {
  const ssh = join(temp(), ".ssh");
  execFileSync("mkdir", ["-p", ssh]);
  writeFileSync(join(ssh, "config"), "Host other\n  HostName other.example.test");
  const first = install(ssh, "--hardware", "machineuser@192.0.2.10");
  assert.equal(first.status, 0, first.stderr);
  const pub = readFileSync(join(ssh, "black4_hardware.pub"), "utf8").trim();
  assert.match(pub, /^ssh-ed25519 \S+ black4-hardware$/);
  assert.ok(first.stdout.includes(pub));
  assert.match(first.stdout, /path=plugins%2Fhardware/);
  const config = readFileSync(join(ssh, "config"), "utf8");
  assert.ok(config.startsWith("Host other\n  HostName other.example.test\n"), "existing config is kept");
  assert.match(config, /Host commerce\n  HostName 192\.0\.2\.10\n  User machineuser\n  IdentityFile \S+black4_hardware\n  IdentitiesOnly yes\n  StrictHostKeyChecking accept-new\n/);

  // Again, with a new address: the same key, one block, updated.
  assert.equal(install(ssh, "--hardware", "machineuser@192.0.2.11").status, 0);
  const again = readFileSync(join(ssh, "config"), "utf8");
  assert.equal(readFileSync(join(ssh, "black4_hardware.pub"), "utf8").trim(), pub);
  assert.equal(again.match(/Host commerce/g).length, 1);
  assert.match(again, /HostName 192\.0\.2\.11/);
  // ssh itself reads it the way the plugin will use it.
  const resolved = execFileSync("ssh", ["-G", "-F", join(ssh, "config"), "commerce"], { encoding: "utf8" });
  assert.match(resolved, /^hostname 192\.0\.2\.11$/m);
  assert.match(resolved, /^user machineuser$/m);
});

test("install.sh --hardware leaves someone's own Host commerce alone", { skip: !sshKeygen }, () => {
  const ssh = join(temp(), ".ssh");
  execFileSync("mkdir", ["-p", ssh]);
  const own = "Host commerce\n  HostName mine.example.test\n";
  writeFileSync(join(ssh, "config"), own);
  const result = install(ssh, "--hardware", "machineuser@192.0.2.10");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(join(ssh, "config"), "utf8"), own);
  assert.match(result.stdout, /already has its own 'Host commerce'/);
});

test("install.sh --hardware needs user@address and refuses odd input", () => {
  const ssh = join(temp(), ".ssh");
  for (const target of ["", "192.0.2.10", "Bad User@192.0.2.10", "user@host;rm"]) {
    assert.notEqual(install(ssh, "--hardware", target).status, 0, target);
  }
});
