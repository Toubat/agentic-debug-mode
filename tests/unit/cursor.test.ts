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
      hypotheses: ["H1"],
      issuedAt: 1_784_310_000_000,
      limit: 100,
      offset: 100,
      program: 'select(.hypothesisId == "H1")',
      sessionId: "session-1",
      slurp: false,
      watermark: 42,
    });

    expect(
      verifyQueryCursor("control-secret", cursor, {
        sessionId: "session-1",
      }),
    ).toMatchObject({
      hypotheses: ["H1"],
      limit: 100,
      offset: 100,
      program: 'select(.hypothesisId == "H1")',
      slurp: false,
      watermark: 42,
    });
    expect(() =>
      verifyQueryCursor("control-secret", `${cursor}x`, {
        sessionId: "session-1",
      }),
    ).toThrow("Invalid query cursor");
  });
});
