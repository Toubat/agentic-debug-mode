import { describe, expect, test } from "bun:test";
import { createSnapshotCursor, verifySnapshotCursor } from "../../src/cli/snapshot-cursor";

describe("snapshot cursor", () => {
  test("round-trips signed scope and rejects tampering", () => {
    const cursor = createSnapshotCursor("control-secret", {
      issuedAt: 1_784_310_000_000,
      runId: "baseline",
      sessionId: "session-1",
      watermark: 42,
    });

    expect(
      verifySnapshotCursor("control-secret", cursor, {
        runId: "baseline",
        sessionId: "session-1",
      }),
    ).toMatchObject({ watermark: 42 });
    expect(() =>
      verifySnapshotCursor("control-secret", `${cursor}x`, {
        runId: "baseline",
        sessionId: "session-1",
      }),
    ).toThrow("Invalid snapshot cursor");
    expect(() =>
      verifySnapshotCursor("control-secret", cursor, {
        runId: "other",
        sessionId: "session-1",
      }),
    ).toThrow("Snapshot cursor scope does not match");
  });
});
