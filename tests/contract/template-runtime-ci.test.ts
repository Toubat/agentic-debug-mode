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
