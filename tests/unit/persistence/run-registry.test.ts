import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Persistence } from "../../../src/daemon/persistence";
import { RunRegistry } from "../../../src/daemon/run-registry";
import { SessionRegistry } from "../../../src/daemon/session-registry";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("run registry", () => {
  test("never replaces a persisted run's hypothesis declarations", async () => {
    const home = await mkdtemp(join(tmpdir(), "agent-debug-mode-home-"));
    temporaryDirectories.push(home);
    const persistence = await Persistence.open(home);
    const session = await new SessionRegistry(persistence).create({
      activeRunId: "baseline",
      workspace: "/workspace/project",
    });
    const runs = new RunRegistry(persistence);
    const baseline = await runs.declare(session.id, {
      createdAt: 1_784_313_600_000,
      hypothesisIds: ["H1", "H2"],
      id: "baseline",
    });

    await expect(
      runs.declare(session.id, {
        createdAt: baseline.createdAt + 1,
        hypothesisIds: ["H3"],
        id: "baseline",
      }),
    ).rejects.toThrow("Run baseline already exists with immutable hypotheses");
    expect(await new RunRegistry(persistence).get(session.id, "baseline")).toEqual(baseline);
  });
});
