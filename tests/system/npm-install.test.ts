import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

const root = join(import.meta.dir, "..", "..");
// The launcher reports the root package version live, so track it rather than a
// hardcoded string that breaks on every Version Packages release bump.
const rootVersion = (
  JSON.parse(await readFile(join(root, "package.json"), "utf8")) as { version: string }
).version;
const temporaryDirectories: string[] = [];
const target = `${process.platform}-${process.arch}`;
const supportedTargets = new Set([
  "darwin-arm64",
  "darwin-x64",
  "linux-arm64",
  "linux-x64",
  "win32-x64",
]);

// On Windows, npm is a `.cmd` shim; Bun.spawn cannot resolve the bare name
// "npm" from PATH (it does not apply PATHEXT), so resolve the full path first.
const npmCommand = Bun.which("npm") ?? (process.platform === "win32" ? "npm.cmd" : "npm");

async function run(command: string[], cwd = root, env = process.env) {
  const child = Bun.spawn(command, {
    cwd,
    env,
    stderr: "pipe",
    stdout: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stderr, stdout };
}

async function pack(directory: string, destination: string): Promise<string> {
  const result = await run([npmCommand, "pack", "--pack-destination", destination, directory]);
  expect(result.exitCode, result.stderr).toBe(0);
  const filename = result.stdout.trim().split("\n").at(-1);
  if (!filename) {
    throw new Error(`npm pack did not report an archive for ${directory}`);
  }
  return join(destination, basename(filename));
}

beforeAll(async () => {
  const built = await run([process.execPath, "run", "build"]);
  expect(built.exitCode, built.stderr).toBe(0);
}, 30_000);

afterAll(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("npm installation", () => {
  test.skipIf(!supportedTargets.has(target))(
    "installs the host optional package and runs without Bun on PATH",
    async () => {
      const temporary = await mkdtemp(join(tmpdir(), "agent-debug-mode-npm-"));
      temporaryDirectories.push(temporary);
      const platformStage = join(temporary, "platform");
      const launcherStage = join(temporary, "launcher");
      const installDirectory = join(temporary, "install");
      await Promise.all([
        cp(join(root, "packages", "platform-binaries", target), platformStage, {
          recursive: true,
        }),
        cp(join(root, "packages", "npm-launcher"), launcherStage, { recursive: true }),
        mkdir(installDirectory, { recursive: true }),
      ]);
      await mkdir(join(platformStage, "bin"), { recursive: true });

      const executableName = process.platform === "win32" ? "debug-mode.exe" : "debug-mode";
      const packagedBinary = join(platformStage, "bin", executableName);
      await cp(join(root, "dist", executableName), packagedBinary);
      if (process.platform !== "win32") {
        await chmod(packagedBinary, 0o755);
      }
      const platformArchive = await pack(platformStage, temporary);

      const launcherManifestPath = join(launcherStage, "package.json");
      const launcherManifest = JSON.parse(await readFile(launcherManifestPath, "utf8")) as Record<
        string,
        unknown
      >;
      launcherManifest.optionalDependencies = {
        [`@agentic-debug-mode/cli-${target}`]: `file:${platformArchive}`,
      };
      await writeFile(launcherManifestPath, `${JSON.stringify(launcherManifest, null, 2)}\n`);
      const launcherArchive = await pack(launcherStage, temporary);

      await writeFile(
        join(installDirectory, "package.json"),
        '{"name":"install-test","private":true}\n',
      );
      const installed = await run(
        [npmCommand, "install", "--ignore-scripts", "--no-audit", "--no-fund", launcherArchive],
        installDirectory,
      );
      expect(installed.exitCode, installed.stderr).toBe(0);

      const command = join(
        installDirectory,
        "node_modules",
        ".bin",
        process.platform === "win32" ? "debug-mode.cmd" : "debug-mode",
      );
      const node = Bun.which("node");
      if (!node) {
        throw new Error("Node.js is required to verify the npm launcher");
      }
      const executed = await run([command, "--version"], installDirectory, {
        ...process.env,
        PATH: dirname(node),
      });
      expect(executed.exitCode, executed.stderr).toBe(0);
      expect(executed.stdout).toContain(rootVersion);
    },
    30_000,
  );
});
