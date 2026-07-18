import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const root = join(import.meta.dir, "..", "..");

interface ChangesetConfig {
  baseBranch?: string;
  privatePackages?: { tag?: boolean; version?: boolean };
}

describe("changesets configuration", () => {
  test("config versions and tags the private root package from main", async () => {
    const config = JSON.parse(
      await readFile(join(root, ".changeset", "config.json"), "utf8"),
    ) as ChangesetConfig;

    expect(config.baseBranch).toBe("main");
    // The publishable root package is private; changesets must still version and tag it
    // so the sync script can propagate the version and release.yml can build the tag.
    expect(config.privatePackages?.version).toBe(true);
    expect(config.privatePackages?.tag).toBe(true);
  });

  test("a version script propagates the root version into distribution packages", async () => {
    const rootManifest = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };

    const versionScript = rootManifest.scripts?.version ?? "";
    expect(versionScript).toContain("changeset version");
    expect(versionScript).toContain("sync-versions");

    const releaseTag = rootManifest.scripts?.["release:tag"] ?? "";
    expect(releaseTag).toContain("release-tag");
  });
});

describe("changesets workflow", () => {
  test("opens the Version Packages PR and dispatches the release build", async () => {
    const workflow = await readFile(join(root, ".github", "workflows", "changesets.yml"), "utf8");

    // Triggered by pushes to main.
    expect(workflow).toContain("push:");
    expect(workflow).toContain("main");

    // Scoped permissions for the Version Packages PR.
    expect(workflow).toContain("contents: write");
    expect(workflow).toContain("pull-requests: write");

    // changesets/action must be pinned to a full 40-character commit SHA.
    expect(workflow).toMatch(/changesets\/action@[0-9a-f]{40}/);

    // The version and publish commands run through the package scripts.
    expect(workflow).toContain("bun run version");
    expect(workflow).toContain("bun run release:tag");

    // A GITHUB_TOKEN-pushed tag does not trigger workflows, so this must
    // explicitly dispatch release.yml once a new version is tagged.
    expect(workflow).toContain("gh workflow run release.yml");
    expect(workflow).toContain("published == 'true'");
  });
});

describe("release workflow triggers", () => {
  test("release.yml builds from both a pushed tag and a dispatched tag", async () => {
    const release = await readFile(join(root, ".github", "workflows", "release.yml"), "utf8");

    // Both trigger paths.
    expect(release).toContain("workflow_dispatch:");
    expect(release).toMatch(/push:\s*\n\s*tags:/);

    // A required tag input for the dispatched path.
    expect(release).toMatch(/inputs:\s*\n\s*tag:/);

    // Version derivation must consider the dispatched input, falling back to the ref name.
    expect(release).toContain("github.event.inputs.tag");
    expect(release).toContain("github.ref_name");
  });
});
