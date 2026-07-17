import { describe, expect, test } from "bun:test";
import type { CommandResult } from "../../src/cli/output-schema";
import { renderPretty } from "../../src/cli/pretty-renderer";

describe("command result rendering", () => {
  test("pretty output orders warnings, summary, data, then hints", () => {
    const result: CommandResult<{ records: string[] }> = {
      command: "logs",
      data: { records: ["evidence"] },
      hints: [
        {
          action: "next-page",
          command: "debug-mode logs --session session-1 --offset 1",
          message: "Read the next page.",
        },
      ],
      ok: true,
      partial: false,
      schemaVersion: 1,
      scope: { runId: "baseline", sessionId: "session-1" },
      statistics: { returnedRecords: 1, totalRecords: 2 },
      warnings: [
        {
          code: "MALFORMED_RECORDS",
          message: "One malformed record was excluded.",
        },
      ],
    };

    expect(renderPretty(result)).toBe(
      [
        "WARNING  [MALFORMED_RECORDS] One malformed record was excluded.",
        "",
        "LOGS",
        "Session session-1  •  Run baseline",
        "returnedRecords  1",
        "totalRecords     2",
        "",
        "records",
        "  evidence",
        "",
        "NEXT-PAGE  Read the next page.",
        "  debug-mode logs --session session-1 --offset 1",
      ].join("\n"),
    );
  });

  test("logs render complete normalized events in a compact table", () => {
    const result: CommandResult<{
      records: Array<Record<string, unknown>>;
    }> = {
      command: "logs",
      data: {
        records: [
          {
            data: { subtotal: 9_000, user: { id: "u1" } },
            hypothesisId: "H1",
            id: "evt_1",
            location: "src/cart.ts:84",
            message: "Before discount",
            receivedAt: 1_784_310_000_456,
            runId: "baseline",
            schemaVersion: 1,
            sequence: 1,
            sessionId: "session-1",
            timestamp: 1_784_310_000_123,
          },
        ],
      },
      hints: [],
      ok: true,
      partial: false,
      schemaVersion: 1,
      scope: { runId: "baseline", sessionId: "session-1" },
      statistics: { returnedRecords: 1, totalRecords: 1 },
      warnings: [],
    };

    const rendered = renderPretty(result);

    expect(rendered).toContain("ID     SEQ");
    expect(rendered).toContain("evt_1");
    expect(rendered).toContain("src/cart.ts:84");
    expect(rendered).toContain('{"subtotal":9000,"user":{"id":"u1"}}');
    expect(rendered.match(/session-1/g)).toHaveLength(1);
    expect(rendered.match(/baseline/g)).toHaveLength(1);
  });

  test("query renders homogeneous flat objects as a table", () => {
    const result: CommandResult<{ rows: unknown[] }> = {
      command: "query",
      data: {
        rows: [
          { count: 2, hypothesisId: "H1" },
          { count: 1, hypothesisId: "H2" },
        ],
      },
      hints: [],
      ok: true,
      partial: false,
      schemaVersion: 1,
      scope: { runId: "baseline", sessionId: "session-1" },
      statistics: { outputValues: 2 },
      warnings: [],
    };

    const rendered = renderPretty(result);

    expect(rendered).toContain("COUNT  HYPOTHESISID");
    expect(rendered).toContain("2      H1");
    expect(rendered).toContain("1      H2");
  });

  test("query keeps nested heterogeneous results as pretty JSON", () => {
    const result: CommandResult<{ rows: unknown[] }> = {
      command: "query",
      data: { rows: [{ nested: { value: 1 } }, ["other"]] },
      hints: [],
      ok: true,
      partial: false,
      schemaVersion: 1,
      scope: { runId: "baseline", sessionId: "session-1" },
      statistics: { outputValues: 2 },
      warnings: [],
    };

    expect(renderPretty(result)).toContain('"nested": {');
    expect(renderPretty(result)).toContain('"other"');
  });

  test("query renders indexed JSON scalars and an explicit empty state", () => {
    const scalars: CommandResult<{ rows: unknown[] }> = {
      command: "query",
      data: { rows: ["1", 1, null] },
      hints: [],
      ok: true,
      partial: false,
      schemaVersion: 1,
      scope: { runId: "baseline", sessionId: "session-1" },
      statistics: { producedValues: 3 },
      warnings: [],
    };
    const empty = { ...scalars, data: { rows: [] } };

    expect(renderPretty(scalars)).toContain('INDEX  VALUE\n1      "1"\n2      1\n3      null');
    expect(renderPretty(empty)).toContain("No values produced");
  });
});
