#!/usr/bin/env node

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const targets = {
  "darwin-arm64": ["@fragarach/cli-darwin-arm64", "fragarach"],
  "darwin-x64": ["@fragarach/cli-darwin-x64", "fragarach"],
  "linux-arm64": ["@fragarach/cli-linux-arm64", "fragarach"],
  "linux-x64": ["@fragarach/cli-linux-x64", "fragarach"],
  "win32-x64": ["@fragarach/cli-win32-x64", "fragarach.exe"]
};

function isFile(file) {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function resolveBinary() {
  if (process.env.FRAGARACH_BINARY) {
    const override = path.resolve(process.env.FRAGARACH_BINARY);
    if (!isFile(override)) {
      throw new Error(`FRAGARACH_BINARY does not point to a file: ${override}`);
    }
    return override;
  }

  const target = `${process.platform}-${process.arch}`;
  const selected = targets[target];
  if (!selected) {
    throw new Error(
      `Unsupported platform ${target}. Supported targets: ${Object.keys(targets).join(", ")}`
    );
  }
  const [packageName, executable] = selected;
  try {
    const manifest = require.resolve(`${packageName}/package.json`);
    const binary = path.join(path.dirname(manifest), "bin", executable);
    if (!isFile(binary)) {
      throw new Error(`binary is missing from ${packageName}`);
    }
    return binary;
  } catch (error) {
    throw new Error(
      `The platform package ${packageName} is not installed correctly. ` +
        `Reinstall fragarach without omitting optional dependencies. Cause: ${error.message}`
    );
  }
}

try {
  const result = spawnSync(resolveBinary(), process.argv.slice(2), {
    stdio: "inherit",
    windowsHide: true
  });
  if (result.error) {
    throw result.error;
  }
  process.exitCode = result.status === null ? 1 : result.status;
} catch (error) {
  console.error(`fragarach: ${error.message}`);
  process.exitCode = 1;
}
