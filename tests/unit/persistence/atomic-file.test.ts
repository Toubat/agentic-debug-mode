import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readJsonFile, renameWithRetry, writeJsonAtomic } from "../../../src/platform/atomic-file";

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

describe("renameWithRetry", () => {
  const errorWithCode = (code: string): NodeJS.ErrnoException => {
    const error = new Error(code) as NodeJS.ErrnoException;
    error.code = code;
    return error;
  };

  test("retries a transiently locked destination on win32 and eventually succeeds", async () => {
    let calls = 0;
    const sleeps: number[] = [];
    await renameWithRetry("from", "to", {
      platform: "win32",
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
      },
      rename: async () => {
        calls += 1;
        if (calls < 4) {
          throw errorWithCode("EPERM");
        }
      },
    });
    expect(calls).toBe(4);
    expect(sleeps).toHaveLength(3);
  });

  test("rethrows after exhausting the attempt budget on win32", async () => {
    let calls = 0;
    await expect(
      renameWithRetry("from", "to", {
        platform: "win32",
        attempts: 3,
        sleep: async () => undefined,
        rename: async () => {
          calls += 1;
          throw errorWithCode("EBUSY");
        },
      }),
    ).rejects.toThrow("EBUSY");
    expect(calls).toBe(3);
  });

  test("does not retry on posix, rethrowing EPERM immediately", async () => {
    let calls = 0;
    await expect(
      renameWithRetry("from", "to", {
        platform: "linux",
        sleep: async () => undefined,
        rename: async () => {
          calls += 1;
          throw errorWithCode("EPERM");
        },
      }),
    ).rejects.toThrow("EPERM");
    expect(calls).toBe(1);
  });

  test("rethrows non-retryable error codes without retrying on win32", async () => {
    let calls = 0;
    await expect(
      renameWithRetry("from", "to", {
        platform: "win32",
        sleep: async () => undefined,
        rename: async () => {
          calls += 1;
          throw errorWithCode("ENOENT");
        },
      }),
    ).rejects.toThrow("ENOENT");
    expect(calls).toBe(1);
  });
});
