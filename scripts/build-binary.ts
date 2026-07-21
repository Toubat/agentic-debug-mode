import { chmod, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const outputDirectory = join(root, "dist");
const executableName = process.platform === "win32" ? "debug-mode.exe" : "debug-mode";
const executable = join(outputDirectory, executableName);

// On Windows a just-exited process (e.g. a debug-mode daemon that ran the
// previous test step's dist/debug-mode.exe) can keep the executable's file
// handle open for a short window after it terminates, so removing dist races
// that release and fails with EACCES/EPERM/EBUSY. Retry with a short backoff
// until the handle is released; other platforms release handles on exit and
// succeed on the first attempt.
async function removeOutputDirectory(): Promise<void> {
  const maxAttempts = 20;
  for (let attempt = 1; ; attempt += 1) {
    try {
      await rm(outputDirectory, { force: true, recursive: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const retriable = code === "EACCES" || code === "EPERM" || code === "EBUSY";
      if (!retriable || attempt >= maxAttempts) {
        throw error;
      }
      await Bun.sleep(250);
    }
  }
}

await removeOutputDirectory();
await mkdir(outputDirectory, { recursive: true });

const processHandle = Bun.spawn(
  ["bun", "build", "--compile", "--outfile", executable, join(root, "src", "cli.ts")],
  {
    cwd: root,
    stderr: "inherit",
    stdout: "inherit",
  },
);
const exitCode = await processHandle.exited;
if (exitCode !== 0) {
  throw new Error(`bun build --compile failed with exit code ${exitCode}`);
}

if (process.platform !== "win32") {
  await chmod(executable, 0o755);
}
