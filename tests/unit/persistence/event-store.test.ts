import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventStore } from "../../../src/daemon/event-store";
import { Persistence } from "../../../src/daemon/persistence";
import { SessionRegistry } from "../../../src/daemon/session-registry";
import type { NormalizedEvent } from "../../../src/domain/event";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

function event(id: string, sequence: number): NormalizedEvent {
  return {
    data: { id },
    hypothesisId: "H1",
    id,
    location: "src/example.ts:1",
    message: "Observed value",
    receivedAt: sequence,
    runId: "baseline",
    schemaVersion: 1,
    sequence,
    sessionId: "assigned-below",
    timestamp: sequence,
  };
}

describe("event store", () => {
  test("serializes a run clear between earlier and later appends", async () => {
    const home = await mkdtemp(join(tmpdir(), "agent-debug-mode-home-"));
    temporaryDirectories.push(home);
    const persistence = await Persistence.open(home);
    const session = await new SessionRegistry(persistence).create({
      activeRunId: "baseline",
      workspace: "/workspace/project",
    });
    const store = new EventStore(persistence);
    const before = { ...event("before", 1), sessionId: session.id };
    const after = { ...event("after", 2), sessionId: session.id };

    const firstAppend = store.append(before);
    const clear = store.clearRun(session.id, "baseline");
    const secondAppend = store.append(after);
    await Promise.all([firstAppend, clear, secondAppend]);

    expect(await store.read(session.id, "baseline")).toEqual([after]);
  });
});
