import { describe, expect, test } from "bun:test";
import {
  createQueryCursor,
  createSnapshotCursor,
  verifyQueryCursor,
  verifySnapshotCursor,
} from "../../src/cli/snapshot-cursor";

describe("snapshot cursor", () => {
  test("round-trips signed scope and rejects tampering", () => {
    const cursor = createSnapshotCursor("control-secret", {
      issuedAt: 1_784_310_000_000,
      sessionId: "session-1",
      watermark: 42,
    });

    expect(
      verifySnapshotCursor("control-secret", cursor, {
        sessionId: "session-1",
      }),
    ).toMatchObject({ watermark: 42 });
    expect(() =>
      verifySnapshotCursor("control-secret", `${cursor}x`, {
        sessionId: "session-1",
      }),
    ).toThrow("Invalid snapshot cursor");
    expect(() =>
      verifySnapshotCursor("control-secret", cursor, {
        sessionId: "session-2",
      }),
    ).toThrow("Snapshot cursor scope does not match");
  });
});

describe("query cursor", () => {
  test("retains authenticated query scope and continuation options", () => {
    const cursor = createQueryCursor("control-secret", {
      continuation: {
        byteOffset: 128,
        kind: "stream",
        outputOrdinal: 2,
      },
      evidenceEpoch: "epoch-1",
      hypotheses: ["H1"],
      issuedAt: 1_784_310_000_000,
      json: true,
      limit: 100,
      program: 'select(.hypothesisId == "H1")',
      sessionId: "session-1",
      slurp: false,
      timeoutMs: 3_000,
      watermark: 42,
    });

    expect(
      verifyQueryCursor("control-secret", cursor, {
        evidenceEpoch: "epoch-1",
        sessionId: "session-1",
      }),
    ).toMatchObject({
      continuation: {
        byteOffset: 128,
        kind: "stream",
        outputOrdinal: 2,
      },
      evidenceEpoch: "epoch-1",
      hypotheses: ["H1"],
      json: true,
      limit: 100,
      program: 'select(.hypothesisId == "H1")',
      slurp: false,
      timeoutMs: 3_000,
      watermark: 42,
    });
    expect(() =>
      verifyQueryCursor("control-secret", `${cursor}x`, {
        evidenceEpoch: "epoch-1",
        sessionId: "session-1",
      }),
    ).toThrow("Invalid query cursor");
    expect(() =>
      verifyQueryCursor("control-secret", cursor, {
        evidenceEpoch: "epoch-2",
        sessionId: "session-1",
      }),
    ).toThrow("Query cursor is stale");
  });
});
