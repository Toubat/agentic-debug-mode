import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QueryTimeoutError, runJaqFilePage } from "../../src/native/query";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

async function eventsFile(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "agent-debug-mode-native-query-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "events.ndjson");
  await writeFile(path, '{"id":"direct","hypothesisId":"H1","sequence":1}\n');
  return path;
}

describe("native query binding", () => {
  test("returns query results through the direct N-API wrapper", async () => {
    const path = await eventsFile();

    const result = runJaqFilePage(".id", path, [], 1, 0, 0, 10, 1_000);

    expect(result.results).toEqual(["direct"]);
  });

  test("maps the native deadline marker to QueryTimeoutError", async () => {
    const path = await eventsFile();

    expect(() => runJaqFilePage("[range(0; 100000)]", path, [], 1, 0, 0, 10, 1)).toThrow(
      QueryTimeoutError,
    );
  });
});
