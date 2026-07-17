import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DiagnosticStore } from "../../../src/daemon/diagnostic-store";
import { EventStore } from "../../../src/daemon/event-store";
import { IngestionService } from "../../../src/daemon/ingest-api";
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
  const registry = new SessionRegistry(persistence, events, diagnostics, sequence);
  return { diagnostics, events, persistence, registry, sequence };
}

function event(id: string, sequence: number): NormalizedEvent {
  return {
    data: { id },
    hypothesisId: "H1",
    id,
    location: "src/example.ts:1",
    message: "Observed value",
    receivedAt: sequence,
    sequence,
    timestamp: sequence,
  };
}

async function replaceWithExternalSymlink(path: string): Promise<void> {
  const external = `${path}.external`;
  await writeFile(external, "external");
  await rm(path);
  await symlink(external, path);
}

describe("session reset", () => {
  test("preserves session identity and replaces the evidence epoch", async () => {
    const { events, registry, sequence } = await fixture();
    const session = await registry.create(1_784_310_000_000);
    await events.append(session.id, event("before", 1));
    await sequence.next(session.id);

    const reset = await registry.reset(session.id);

    expect(reset.id).toBe(session.id);
    expect(reset.createdAt).toBe(session.createdAt);
    expect(reset.evidenceEpoch).not.toBe(session.evidenceEpoch);
    expect(await events.read(session.id)).toEqual([]);
    expect(await sequence.next(session.id)).toBe(1);
  });

  test("clears diagnostics, direct input, and cursor metadata", async () => {
    const { diagnostics, persistence, registry } = await fixture();
    const session = await registry.create();
    await diagnostics.append(session.id, [
      {
        diagnosticId: "diag_1",
        message: "Invalid",
        observedAt: 1,
        reason: "INVALID_JSON",
        recoverable: {},
        redactedPreview: "[redacted]",
        suggestedAction: "Retry",
      },
    ]);
    await writeFile(registry.incomingPath(session.id), '{"message":"before"}\n');
    await writeFile(persistence.sessionFile(session.id, "incoming.cursor.json"), '{"offset":21}\n');

    await registry.reset(session.id);

    expect(await diagnostics.read(session.id)).toEqual([]);
    expect(await readFile(registry.incomingPath(session.id), "utf8")).toBe("");
    expect(
      JSON.parse(
        await readFile(persistence.sessionFile(session.id, "incoming.cursor.json"), "utf8"),
      ),
    ).toEqual({ offset: 0 });
  });

  test("waits for already-started ingestion before clearing evidence", async () => {
    const { diagnostics, events, persistence, registry, sequence } = await fixture();
    const session = await registry.create();
    const ingestion = new IngestionService(registry, events, diagnostics, sequence);
    let release: (() => void) | undefined;
    let markEntered: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve;
    });
    const blocked = persistence.runSessionOperation(
      session.id,
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
          markEntered?.();
        }),
    );
    await entered;
    const ingesting = ingestion.ingest(session.id, {
      data: { value: "before" },
      hypothesisId: "H1",
      location: "src/example.ts:1",
      message: "Observed value",
      timestamp: 1,
    });
    const resetting = registry.reset(session.id);

    release?.();
    await Promise.all([blocked, ingesting, resetting]);

    expect(await events.read(session.id)).toEqual([]);
    expect(await sequence.next(session.id)).toBe(1);
  });

  test("refuses files redirected through symbolic links before reset or removal", async () => {
    const { persistence, registry } = await fixture();
    const session = await registry.create();
    await replaceWithExternalSymlink(persistence.sessionFile(session.id, "events.ndjson"));

    await expect(registry.reset(session.id)).rejects.toThrow("symbolic link");
    await expect(registry.remove(session.id)).rejects.toThrow("symbolic link");
  });
});
