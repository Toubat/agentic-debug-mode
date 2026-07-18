import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { $ } from "bun";

// Publish command for changesets/action. When the "Version Packages" PR merges into main this
// runs with no pending changesets, so it creates the vX.Y.Z tag for the freshly bumped root
// version and pushes it. The build/publish pipeline in release.yml is dispatched separately,
// because tags pushed with GITHUB_TOKEN do not trigger workflows.
//
// The final `New tag:` line is the signal changesets/action greps for to set its `published`
// output, which the workflow uses to decide whether to dispatch release.yml.

const root = join(import.meta.dir, "..");
const version = JSON.parse(await readFile(join(root, "package.json"), "utf8")).version as string;
const tag = `v${version}`;

const remote = (await $`git ls-remote --tags origin ${`refs/tags/${tag}`}`.text()).trim();
if (remote.length > 0) {
  console.log(`Tag ${tag} already exists on origin; nothing to release.`);
  process.exit(0);
}

// `changeset tag` creates the vX.Y.Z tag for the root package (single-package repos use the
// v-prefixed form) using the changesets tag convention.
await $`changeset tag`;
await $`git push origin ${tag}`;

console.log(`New tag: ${tag}`);
