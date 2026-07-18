import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";

const repositoryRoot = join(import.meta.dir, "../..");

test("obsolete query worker command and runner are absent", async () => {
  const cliSource = await Bun.file(join(repositoryRoot, "src", "cli.ts")).text();

  expect(cliSource).not.toContain(["__query", "native"].join("-"));
  expect(existsSync(join(repositoryRoot, "src", "cli", "query-runner.ts"))).toBe(false);
});
