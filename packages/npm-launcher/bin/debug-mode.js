#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const packageByTarget = {
  "darwin-arm64": "@agentic-debug-mode/cli-darwin-arm64",
  "darwin-x64": "@agentic-debug-mode/cli-darwin-x64",
  "linux-arm64": "@agentic-debug-mode/cli-linux-arm64",
  "linux-x64": "@agentic-debug-mode/cli-linux-x64",
  "win32-x64": "@agentic-debug-mode/cli-win32-x64",
};

function resolveBinary() {
  const target = `${process.platform}-${process.arch}`;
  const packageName = packageByTarget[target];
  if (!packageName) {
    throw new Error(`agentic-debug-mode does not provide a binary for ${target}`);
  }

  try {
    const packageJson = require.resolve(`${packageName}/package.json`);
    const executable = process.platform === "win32" ? "debug-mode.exe" : "debug-mode";
    return join(dirname(packageJson), "bin", executable);
  } catch {
    throw new Error(
      `The optional package ${packageName} is missing. Reinstall agentic-debug-mode without omitting optional dependencies.`,
    );
  }
}

let binary;
try {
  binary = resolveBinary();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

const result = spawnSync(binary, process.argv.slice(2), {
  stdio: "inherit",
  windowsHide: true,
});
if (result.error) {
  console.error(`Unable to launch ${binary}: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
