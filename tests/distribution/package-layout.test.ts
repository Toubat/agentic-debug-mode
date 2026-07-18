import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const root = join(import.meta.dir, "..", "..");
const launcherDirectory = join(root, "packages", "npm-launcher");
const platformsDirectory = join(root, "packages", "platform-binaries");
const targets = ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64", "win32-x64"] as const;

interface PackageManifest {
  bin?: Record<string, string>;
  cpu?: string[];
  name: string;
  optionalDependencies?: Record<string, string>;
  os?: string[];
  version: string;
}

async function manifest(path: string): Promise<PackageManifest> {
  return JSON.parse(await readFile(path, "utf8")) as PackageManifest;
}

describe("npm distribution layout", () => {
  test("launcher selects every supported optional binary package", async () => {
    const launcher = await manifest(join(launcherDirectory, "package.json"));

    expect(launcher.name).toBe("agentic-debug-mode");
    expect(launcher.bin).toEqual({ "debug-mode": "bin/debug-mode.js" });
    expect(Object.keys(launcher.optionalDependencies ?? {}).sort()).toEqual(
      targets.map((target) => `@agentic-debug-mode/cli-${target}`).sort(),
    );
    expect(new Set(Object.values(launcher.optionalDependencies ?? {}))).toEqual(
      new Set([launcher.version]),
    );
  });

  test("platform packages constrain installation to their target", async () => {
    for (const target of targets) {
      const platform = target.split("-")[0] ?? "";
      const architecture = target.split("-")[1] ?? "";
      const packageJson = await manifest(join(platformsDirectory, target, "package.json"));

      expect(packageJson.name).toBe(`@agentic-debug-mode/cli-${target}`);
      expect(packageJson.os).toEqual([platform]);
      expect(packageJson.cpu).toEqual([architecture]);
      expect(packageJson.version).toBe("0.1.0");
    }
  });
});

describe("release definitions", () => {
  test("Homebrew selects checksummed Apple Silicon and Intel artifacts", async () => {
    const formula = await readFile(
      join(root, "packaging", "homebrew", "agentic-debug-mode.rb"),
      "utf8",
    );

    expect(formula).toContain("agentic-debug-mode-darwin-arm64.tar.gz");
    expect(formula).toContain("agentic-debug-mode-darwin-x64.tar.gz");
    expect(formula.match(/sha256/g)).toHaveLength(2);
  });

  test("CI and release workflows cover all supported targets", async () => {
    const release = await readFile(join(root, ".github", "workflows", "release.yml"), "utf8");
    for (const target of targets) {
      expect(release).toContain(target);
    }
    expect(release).toContain("bun run check");
    expect(release).toContain("bun run typecheck");
    expect(release).toContain("bun run test");
    expect(release).toContain("checksums.txt");
    expect(release).toContain("anchore/sbom-action@");
    expect(release).toContain("agentic-debug-mode.spdx.json");
    expect(release).toContain("cosign sign-blob");
    expect(release).toContain("checksums.txt.sig");
    expect(release).toContain("build:\n    permissions:\n      contents: read");
    expect(release).toContain(
      "publish:\n    permissions:\n      contents: write\n      id-token: write",
    );
    expect(release).toContain("require('./package.json').version");
  });
});
