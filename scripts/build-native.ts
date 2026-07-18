import { access, copyFile, rm } from "node:fs/promises";
import { join } from "node:path";

const root = join(import.meta.dir, "..");

const LOCK_ERROR_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Copy the freshly built library into place. On Windows the destination addon
 * may be transiently locked by a running process that has it loaded (e.g. a
 * daemon that is shutting down). Retry briefly; if it stays locked and a
 * previously built addon is already present, keep it — cargo has already
 * produced an up-to-date library at `source`, and the loaded copy is from the
 * same build, so the artifact on disk is current either way.
 */
async function replaceArtifact(source: string, destination: string): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      await rm(destination, { force: true });
      await copyFile(source, destination);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const locked =
        process.platform === "win32" && code !== undefined && LOCK_ERROR_CODES.has(code);
      if (!locked || attempt === 9) {
        if (locked && (await exists(destination))) {
          console.warn(
            `Keeping existing ${destination}: destination is locked by a running process (${code}).`,
          );
          return;
        }
        throw error;
      }
      await sleep(50 * (attempt + 1));
    }
  }
}

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
  const processHandle = Bun.spawn(["cargo", "build", "--release", "--package", packageName], {
    cwd: root,
    stderr: "inherit",
    stdout: "inherit",
  });
  const exitCode = await processHandle.exited;
  if (exitCode !== 0) {
    throw new Error(`cargo build failed for ${packageName} with exit code ${exitCode}`);
  }

  const source = join(root, "target", "release", dynamicLibraryName(crateName));
  await replaceArtifact(source, destination);
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
