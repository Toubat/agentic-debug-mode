import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Persistence } from "../../../src/daemon/persistence";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("persistence path safety", () => {
  test("rejects session identifiers and filenames that could escape the state root", async () => {
    const home = await mkdtemp(join(tmpdir(), "agent-debug-mode-home-"));
    temporaryDirectories.push(home);
    const persistence = await Persistence.open(home);

    expect(() => persistence.sessionDirectory("../outside")).toThrow("Invalid session ID");
    expect(() => persistence.sessionFile("safe", "../../secret.json")).toThrow(
      "Invalid session filename",
    );
  });
});
