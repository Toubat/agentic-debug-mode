import { describe, expect, test } from "bun:test";
import type { NormalizedEvent, ProbeEvent } from "../../src/domain/event";
import type { Session } from "../../src/domain/session";

describe("session-only domain", () => {
  test("contains no workspace, run, status, or duplicated session event fields", () => {
    const session: Session = {
      createdAt: 1_784_310_000_000,
      eventSchemaVersion: 1,
      evidenceEpoch: "epoch-1",
      id: "session-1",
    };
    const probe: ProbeEvent = {
      data: { value: 42 },
      hypothesisId: "H1",
      location: "src/example.ts:1",
      message: "Observed value",
      timestamp: 1_784_310_000_001,
    };
    const stored: NormalizedEvent = {
      ...probe,
      id: "evt_1",
      receivedAt: 1_784_310_000_002,
      sequence: 1,
    };

    expect(session).not.toHaveProperty("workspace");
    expect(session).not.toHaveProperty("activeRunId");
    expect(probe).not.toHaveProperty("sessionId");
    expect(probe).not.toHaveProperty("runId");
    expect(stored.sequence).toBe(1);
  });
});
