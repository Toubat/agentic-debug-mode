import { copyFile, rm } from "node:fs/promises";
import { join } from "node:path";

const root = join(import.meta.dir, "..");

function dynamicLibraryName(crateName: string): string {
  if (process.platform === "win32") {
    return `${crateName}.dll`;
  }
  if (process.platform === "darwin") {
    return `lib${crateName}.dylib`;
  }
  return `lib${crateName}.so`;
}

async function build(packageName: string, crateName: string, destination: string) {
  const processHandle = Bun.spawn(
    ["cargo", "build", "--release", "--package", packageName],
    {
      cwd: root,
      stderr: "inherit",
      stdout: "inherit",
    },
  );
  const exitCode = await processHandle.exited;
  if (exitCode !== 0) {
    throw new Error(`cargo build failed for ${packageName} with exit code ${exitCode}`);
  }

  const source = join(root, "target", "release", dynamicLibraryName(crateName));
  await rm(destination, { force: true });
  await copyFile(source, destination);
}

await build(
  "agentic-debug-mode-query",
  "agentic_debug_mode_query",
  join(root, "native", "query", "addon.node"),
);
await build(
  "agentic-debug-mode-system",
  "agentic_debug_mode_system",
  join(root, "native", "system", "addon.node"),
);
