import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const root = join(import.meta.dir, "..", "..");

test("CI installs and requires every advertised template runtime", async () => {
  const workflow = await readFile(join(root, ".github", "workflows", "ci.yml"), "utf8");

  for (const required of [
    "actions/setup-go@",
    "ruby/setup-ruby@",
    "shivammathur/setup-php@",
    "actions/setup-dotnet@",
    "setup-pwsh@",
    'REQUIRE_TEMPLATE_RUNTIMES: "1"',
    "macos-14",
  ]) {
    expect(workflow).toContain(required);
  }
});

test("CI builds the full distribution artifacts as a dedicated step", async () => {
  const workflow = await readFile(join(root, ".github", "workflows", "ci.yml"), "utf8");

  expect(workflow).toContain("name: Build");
  expect(workflow).toContain("run: bun run build");
  expect(workflow).not.toContain("run: bun run build:native");
});
