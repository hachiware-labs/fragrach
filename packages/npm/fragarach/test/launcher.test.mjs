import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test from "node:test";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const repository = path.resolve(testDirectory, "../../../..");
const executable = path.join(
  repository,
  "target",
  "debug",
  process.platform === "win32" ? "fragarach.exe" : "fragarach"
);
const launcher = path.join(testDirectory, "..", "bin", "fragarach.js");

test("npm launcher delegates to the Rust CLI", () => {
  const result = spawnSync(process.execPath, [launcher, "--help"], {
    cwd: repository,
    encoding: "utf8",
    env: { ...process.env, FRAGARACH_BINARY: executable }
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Compile source documents/);
  assert.match(result.stdout, /compile/);
  assert.match(result.stdout, /export/);
});

test("npm launcher explains a missing binary override", () => {
  const result = spawnSync(process.execPath, [launcher, "--help"], {
    encoding: "utf8",
    env: { ...process.env, FRAGARACH_BINARY: path.join(repository, "missing-binary") }
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /does not point to a file/);
});
