import { chmod, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const outputDirectory = join(root, "dist");
const executableName = process.platform === "win32" ? "debug-mode.exe" : "debug-mode";
const executable = join(outputDirectory, executableName);

await rm(outputDirectory, { force: true, recursive: true });
await mkdir(outputDirectory, { recursive: true });

const processHandle = Bun.spawn(
  [
    "bun",
    "build",
    "--compile",
    "--outfile",
    executable,
    join(root, "src", "cli.ts"),
  ],
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
