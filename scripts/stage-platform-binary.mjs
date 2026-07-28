import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const target = `${process.platform}-${process.arch}`;
const supported = new Set([
  "darwin-arm64",
  "darwin-x64",
  "linux-arm64",
  "linux-x64",
  "win32-x64"
]);

if (!supported.has(target)) {
  throw new Error(`Cannot stage an npm binary for unsupported host ${target}`);
}

const executable = process.platform === "win32" ? "fragarach.exe" : "fragarach";
const source = path.resolve(
  process.argv[2] ?? path.join(repository, "target", "release", executable)
);
if (!fs.existsSync(source) || !fs.statSync(source).isFile()) {
  throw new Error(`Release binary is missing: ${source}. Run cargo build --release first.`);
}

const destinationDirectory = path.join(
  repository,
  "packages",
  "npm",
  "platforms",
  target,
  "bin"
);
const destination = path.join(destinationDirectory, executable);
fs.mkdirSync(destinationDirectory, { recursive: true });
fs.copyFileSync(source, destination);
if (process.platform !== "win32") {
  fs.chmodSync(destination, 0o755);
}
console.log(`Staged ${source} -> ${destination}`);
