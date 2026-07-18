import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

// Changesets can only version the single (private) workspace root package. The launcher and
// per-platform packages under packages/ are published artifacts that are not workspace members,
// so this script propagates the root version into them after `changeset version` runs. The
// distribution layout test stays the authority on the resulting invariants.

const root = join(import.meta.dir, "..");
const targets = ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64", "win32-x64"] as const;

interface PackageManifest {
  optionalDependencies?: Record<string, string>;
  version: string;
}

async function readManifest(path: string): Promise<PackageManifest> {
  return JSON.parse(await readFile(path, "utf8")) as PackageManifest;
}

async function writeManifest(path: string, manifest: PackageManifest): Promise<void> {
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`);
}

const version = (await readManifest(join(root, "package.json"))).version;

const launcherPath = join(root, "packages", "npm-launcher", "package.json");
const launcher = await readManifest(launcherPath);
launcher.version = version;
for (const dependency of Object.keys(launcher.optionalDependencies ?? {})) {
  (launcher.optionalDependencies as Record<string, string>)[dependency] = version;
}
await writeManifest(launcherPath, launcher);

for (const target of targets) {
  const path = join(root, "packages", "platform-binaries", target, "package.json");
  const platform = await readManifest(path);
  platform.version = version;
  await writeManifest(path, platform);
}

console.log(`Synced launcher and platform packages to version ${version}`);
