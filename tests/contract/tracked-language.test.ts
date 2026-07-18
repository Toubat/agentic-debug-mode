import { expect, test } from "bun:test";
import { join } from "node:path";

const repositoryRoot = join(import.meta.dir, "../..");
const prohibitedTerm = ["leg", "acy"].join("");

test("tracked repository text excludes prohibited compatibility terminology", async () => {
  const child = Bun.spawn(["git", "ls-files", "-z"], {
    cwd: repositoryRoot,
    stderr: "pipe",
    stdout: "pipe",
  });
  const [exitCode, stderr, output] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
    new Response(child.stdout).text(),
  ]);
  expect(exitCode, stderr).toBe(0);

  const paths = output.split("\0").filter(Boolean);
  const matches: string[] = [];
  for (const path of paths) {
    if (path.toLowerCase().includes(prohibitedTerm)) {
      matches.push(path);
    }
    const contents = await Bun.file(join(repositoryRoot, path)).text();
    for (const [index, line] of contents.split("\n").entries()) {
      if (line.toLowerCase().includes(prohibitedTerm)) {
        matches.push(`${path}:${index + 1}`);
      }
    }
  }

  expect(matches).toEqual([]);
});
