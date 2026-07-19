import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const root = join(import.meta.dir, "..", "..");
const rootManifestPromise = readFile(join(root, "package.json"), "utf8").then(
  (contents) => JSON.parse(contents) as { version: string },
);
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
    const rootVersion = (await rootManifestPromise).version;

    expect(launcher.name).toBe("agentic-debug-mode");
    // The version script keeps the launcher in lockstep with the root package.
    expect(launcher.version).toBe(rootVersion);
    expect(launcher.bin).toEqual({ "debug-mode": "bin/debug-mode.js" });
    expect(Object.keys(launcher.optionalDependencies ?? {}).sort()).toEqual(
      targets.map((target) => `agentic-debug-mode-${target}`).sort(),
    );
    expect(new Set(Object.values(launcher.optionalDependencies ?? {}))).toEqual(
      new Set([launcher.version]),
    );
  });

  test("platform packages constrain installation to their target", async () => {
    const rootVersion = (await rootManifestPromise).version;
    for (const target of targets) {
      const platform = target.split("-")[0] ?? "";
      const architecture = target.split("-")[1] ?? "";
      const packageJson = await manifest(join(platformsDirectory, target, "package.json"));

      expect(packageJson.name).toBe(`agentic-debug-mode-${target}`);
      expect(packageJson.os).toEqual([platform]);
      expect(packageJson.cpu).toEqual([architecture]);
      // The version script keeps every platform package in lockstep with the root package.
      expect(packageJson.version).toBe(rootVersion);
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
    // Release build jobs validate artifact integrity only (build + the distribution
    // suite); the full source gate (check, typecheck, language e2e) lives in CI on main.
    expect(release).toContain("bun run build");
    expect(release).toContain("bun test tests/distribution");
    // Publishes must be retry-idempotent: a half-completed run re-dispatched
    // later would otherwise 403 on the versions that already landed.
    expect(release).toContain("already published; skipping");
    // native-smoke's beforeAll compiles the standalone, which links the native
    // addons produced by build:native, so build:native must run before the
    // distribution suite. Match "run: bun run build:native" explicitly (its own
    // step) to keep this index distinct from the plain "bun run build" step.
    expect(release).toContain("bun run build:native");
    expect(release.indexOf("run: bun run build:native")).toBeLessThan(
      release.indexOf("bun test tests/distribution"),
    );
    // native-smoke's afterAll removes dist/, so distribution tests must run
    // before the release build that produces the verified/uploaded binary. The
    // trailing newline pins the match to the plain build step, never build:native.
    expect(release.indexOf("bun test tests/distribution")).toBeLessThan(
      release.indexOf("run: bun run build\n"),
    );
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
