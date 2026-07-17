import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readJsonFile, writeJsonAtomic } from "../../../src/platform/atomic-file";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("atomic metadata files", () => {
  test("concurrent replacements leave one complete document and no temporary files", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agent-debug-mode-atomic-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "session.json");
    const documents = Array.from({ length: 20 }, (_, index) => ({
      id: `session-${index}`,
      values: Array.from({ length: 100 }, () => index),
    }));

    await Promise.all(documents.map((document) => writeJsonAtomic(path, document)));

    expect(documents).toContainEqual(await readJsonFile(path));
    expect((await readdir(directory)).sort()).toEqual(["session.json"]);
  });
});
