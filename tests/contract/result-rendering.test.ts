import { describe, expect, test } from "bun:test";
import { renderPretty } from "../../src/cli/pretty-renderer";
import type { CommandResult } from "../../src/cli/output-schema";

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
});
