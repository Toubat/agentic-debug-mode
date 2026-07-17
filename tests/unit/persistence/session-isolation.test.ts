import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DiagnosticStore } from "../../../src/daemon/diagnostic-store";
import { EventStore } from "../../../src/daemon/event-store";
import { Persistence } from "../../../src/daemon/persistence";
import { EventSequence } from "../../../src/daemon/sequence";
import { SessionRegistry } from "../../../src/daemon/session-registry";
import type { NormalizedEvent } from "../../../src/domain/event";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "agent-debug-mode-home-"));
  temporaryDirectories.push(home);
  const persistence = await Persistence.open(home);
  const events = new EventStore(persistence);
  const diagnostics = new DiagnosticStore(persistence);
  const sequence = new EventSequence(events);
  const sessions = new SessionRegistry(persistence, events, diagnostics, sequence);
  return { events, sessions };
}

function event(id: string): NormalizedEvent {
  return {
    data: { id },
    hypothesisId: "H1",
    id,
    location: "src/example.ts:1",
    message: "Observed value",
    receivedAt: 1,
    sequence: 1,
    timestamp: 1,
  };
}

describe("session persistence", () => {
  test("keeps sessions isolated under the user state root", async () => {
    const { sessions } = await fixture();

    const first = await sessions.create();
    const second = await sessions.create();

    expect(first.id).not.toBe(second.id);
    expect(await sessions.get(first.id)).toEqual(first);
    expect(await sessions.get(second.id)).toEqual(second);
  });

  test("default listing returns at most twenty sessions created today", async () => {
    const { sessions } = await fixture();
    const today = new Date(2026, 6, 17, 12);
    await sessions.create(new Date(2026, 6, 16, 23).valueOf());
    for (let index = 0; index < 25; index += 1) {
      await sessions.create(new Date(2026, 6, 17, 1, index).valueOf());
    }

    const listed = await sessions.list({ all: false, now: today });

    expect(listed).toHaveLength(20);
    expect(listed.every((item) => new Date(item.createdAt).getDate() === 17)).toBe(true);
    expect(listed[0]?.createdAt).toBeGreaterThan(listed[19]?.createdAt ?? 0);
    const limited = await sessions.list({ all: false, limit: 1, now: today });
    expect(limited).toHaveLength(1);
    expect(limited[0]).toEqual(listed[0]);
  });

  test("all-session listing includes event counts without a limit", async () => {
    const { events, sessions } = await fixture();
    const first = await sessions.create(1);
    const second = await sessions.create(2);
    await events.append(second.id, event("second"));

    expect(await sessions.list({ all: true })).toEqual([
      { createdAt: second.createdAt, eventCount: 1, id: second.id },
      { createdAt: first.createdAt, eventCount: 0, id: first.id },
    ]);
  });

  test("removes one session without affecting another", async () => {
    const { sessions } = await fixture();
    const first = await sessions.create();
    const second = await sessions.create();

    expect(await sessions.remove(first.id)).toBe(true);
    expect(await sessions.remove(first.id)).toBe(false);
    expect(await sessions.get(second.id)).toEqual(second);
  });
});
