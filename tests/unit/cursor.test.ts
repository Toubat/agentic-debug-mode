import { describe, expect, test } from "bun:test";
import { createSnapshotCursor, verifySnapshotCursor } from "../../src/cli/snapshot-cursor";

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
