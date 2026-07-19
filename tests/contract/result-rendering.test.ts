import { describe, expect, test } from "bun:test";
import type { CommandOutput, CommandResult } from "../../src/cli/output-schema";
import { renderPretty } from "../../src/cli/pretty-renderer";
import { templateCommand } from "../../src/commands/template";

const commandFixtures = {
  clean: {
    command: "clean",
    data: { removed: true },
    hints: [],
    ok: true,
    partial: false,
    schemaVersion: 1,
    scope: { sessionId: "session-1" },
    statistics: {},
    warnings: [],
  },
  create: {
    command: "create",
    data: {
      appendPath: "~/.agent-debug-mode/sessions/session-1/incoming.ndjson",
      ingestUrl: "http://127.0.0.1:4319/ingest/session-1",
      sessionId: "session-1",
    },
    hints: [],
    ok: true,
    partial: false,
    schemaVersion: 1,
    scope: { sessionId: "session-1" },
    statistics: {},
    warnings: [],
  },
  logs: {
    command: "logs",
    data: { mode: "streaming", pagination: { hasNext: false, hasPrevious: false }, records: [] },
    hints: [],
    ok: true,
    partial: false,
    schemaVersion: 1,
    scope: { hypothesisFilter: null, sessionId: "session-1" },
    statistics: { returnedRecords: 0, totalRecords: 0, validRecords: 0 },
    warnings: [],
  },
  query: {
    command: "query",
    data: { mode: "streaming", pagination: { hasNext: false }, rows: [], slurp: false },
    hints: [],
    ok: true,
    partial: false,
    schemaVersion: 1,
    scope: { hypothesisFilter: null, sessionId: "session-1" },
    statistics: { producedValues: 0, returnedRecords: 0 },
    warnings: [],
  },
  reset: {
    command: "reset",
    data: {
      appendPath: "~/.agent-debug-mode/sessions/session-1/incoming.ndjson",
      ingestUrl: "http://127.0.0.1:4319/ingest/session-1",
      sessionId: "session-1",
    },
    hints: [],
    ok: true,
    partial: false,
    schemaVersion: 1,
    scope: { sessionId: "session-1" },
    statistics: {},
    warnings: [],
  },
  sessions: {
    command: "sessions",
    data: {
      sessions: [{ createdAt: 1_784_310_000_000, eventCount: 3, id: "session-1" }],
    },
    hints: [],
    ok: true,
    partial: false,
    schemaVersion: 1,
    scope: {},
    statistics: { sessionCount: 1 },
    warnings: [],
  },
  status: {
    command: "status",
    data: {
      diagnostics: [
        {
          diagnosticId: "malformed_01",
          message: "Unexpected token after the data field.",
          observedAt: 1_784_313_600_000,
          reason: "INVALID_JSON",
          recoverable: { hypothesisId: "H2", location: "src/cache.ts:84" },
          redactedPreview: '{"hypothesisId":"H2", ...',
          suggestedAction: "Fix the emitting observation for unsafe manual serialization.",
        },
      ],
      health: { daemon: "healthy", ingestion: "degraded", queryEngine: "ready" },
      session: {
        createdAt: 1_784_310_000_000,
        eventSchemaVersion: 1,
        evidenceEpoch: "epoch-1",
        id: "session-1",
      },
    },
    hints: [
      {
        action: "reset",
        command: "debug-mode reset --session session-1",
        message: "Fix the listed emitters, reset this session, and reproduce.",
      },
    ],
    ok: true,
    partial: false,
    schemaVersion: 1,
    scope: { sessionId: "session-1" },
    statistics: {
      diagnosticCount: 1,
      eventCount: 4,
      malformedRecords: 1,
      totalRecords: 5,
      validRecords: 4,
    },
    warnings: [
      { code: "EVIDENCE_DIAGNOSTICS", message: "1 evidence diagnostics require attention." },
    ],
  },
  stop: {
    command: "stop",
    data: { status: "stopped" },
    hints: [],
    ok: true,
    partial: false,
    schemaVersion: 1,
    scope: {},
    statistics: {},
    warnings: [],
  },
  template: templateCommand("typescript", "http"),
} satisfies Record<string, CommandOutput>;

function renderFixture(command: string, json: boolean): string {
  const output = (commandFixtures as Record<string, CommandOutput>)[command];
  if (!output) {
    throw new Error(`Missing fixture for command ${command}`);
  }
  return json ? JSON.stringify(output) : renderPretty(output);
}

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
      scope: { hypothesisFilter: null, sessionId: "session-1" },
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
        "Session session-1",
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

  test("object-valued statistics render readably instead of [object Object]", () => {
    const result: CommandResult<{ records: string[] }> = {
      command: "logs",
      data: { records: ["evidence"] },
      hints: [],
      ok: true,
      partial: false,
      schemaVersion: 1,
      scope: { hypothesisFilter: null, sessionId: "session-1" },
      statistics: { recordsByHypothesis: { H1: 3, H2: 1 }, returnedRecords: 4 },
      warnings: [],
    };

    const rendered = renderPretty(result);

    expect(rendered).not.toContain("[object Object]");
    expect(rendered).toContain("recordsByHypothesis  H1=3, H2=1");
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
            sequence: 1,
            timestamp: 1_784_310_000_123,
          },
        ],
      },
      hints: [],
      ok: true,
      partial: false,
      schemaVersion: 1,
      scope: { hypothesisFilter: null, sessionId: "session-1" },
      statistics: { returnedRecords: 1, totalRecords: 1 },
      warnings: [],
    };

    const rendered = renderPretty(result);

    // Token-lean table: SEQ is the record handle; the ID column is dropped.
    expect(rendered).toContain("SEQ  TIME");
    expect(rendered).not.toContain("evt_1");
    // RECEIVED column is dropped (receivedAt stays in --json/storage).
    expect(rendered).not.toContain("RECEIVED");
    expect(rendered).not.toContain("17:40:00.456");
    // TIME renders as a compact HH:MM:SS.mmm, not the full ISO timestamp.
    expect(rendered).toContain("17:40:00.123");
    expect(rendered).not.toContain("2026-07-17T17:40:00.123Z");
    // The UTC date is printed once as a header, not repeated per row.
    expect(rendered.match(/date 2026-07-17/g)).toHaveLength(1);
    expect(rendered).toContain("src/cart.ts:84");
    expect(rendered).toContain('{"subtotal":9000,"user":{"id":"u1"}}');
    expect(rendered.match(/session-1/g)).toHaveLength(1);
  });

  test("logs emit a day-separator only when records cross a UTC day", () => {
    const base = {
      hints: [],
      ok: true,
      partial: false,
      schemaVersion: 1,
      scope: { hypothesisFilter: null, sessionId: "session-1" },
      statistics: { returnedRecords: 2, totalRecords: 2 },
      warnings: [],
    };
    const record = (sequence: number, timestamp: number) => ({
      data: { ok: true },
      hypothesisId: "H1",
      id: `evt_${sequence}`,
      location: "src/cart.ts:84",
      message: "step",
      receivedAt: timestamp,
      sequence,
      timestamp,
    });

    const sameDay = renderPretty({
      command: "logs",
      data: { records: [record(1, 1_784_310_000_123), record(2, 1_784_310_000_500)] },
      ...base,
    } as unknown as CommandResult);
    expect(sameDay).toContain("date 2026-07-17");
    expect(sameDay).not.toContain("2026-07-18");

    const crossDay = renderPretty({
      command: "logs",
      data: { records: [record(1, 1_784_310_000_123), record(2, 1_784_396_400_123)] },
      ...base,
    } as unknown as CommandResult);
    expect(crossDay).toContain("date 2026-07-17");
    expect(crossDay).toContain("2026-07-18");
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
      scope: { hypothesisFilter: null, sessionId: "session-1" },
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
      scope: { hypothesisFilter: null, sessionId: "session-1" },
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
      scope: { hypothesisFilter: null, sessionId: "session-1" },
      statistics: { producedValues: 3 },
      warnings: [],
    };
    const empty = { ...scalars, data: { rows: [] } };

    expect(renderPretty(scalars)).toContain('INDEX  VALUE\n1      "1"\n2      1\n3      null');
    expect(renderPretty(empty)).toContain("No values produced");
  });

  test("template output explains exact source without JSON field paths", () => {
    const rendered = renderPretty(commandFixtures.template);

    expect(rendered).toContain("HELPER TEMPLATE");
    expect(rendered).toContain("CALL TEMPLATE");
    expect(rendered).toContain("PLACEHOLDERS");
    expect(rendered).toContain("EVENT SCHEMA");
    expect(rendered).toContain("timestamp  Unix epoch milliseconds");
    expect(rendered).not.toContain("helperTemplate");
    expect(rendered).not.toContain("callTemplate");
    expect(rendered).not.toContain("eventSchema");
  });

  test("status renders evidence health without service-internal wording", () => {
    const rendered = renderPretty(commandFixtures.status);

    expect(rendered).not.toContain("daemon");
    expect(rendered).toContain("Service healthy");
    expect(rendered).toContain("Ingestion degraded");
    expect(rendered).toContain("Query engine ready");
    expect(rendered).toContain("MALFORMED RECORDS");
    expect(rendered).toContain("malformed_01");
    expect(rendered).toContain("src/cache.ts:84");
    expect(rendered).toContain("Fix the emitting observation");
  });

  test("create and reset render the ingest URL and append path with stable labels", () => {
    for (const command of ["create", "reset"] as const) {
      const rendered = renderPretty(commandFixtures[command]);
      expect(rendered).toContain("Ingest URL");
      expect(rendered).toContain("Append Path");
      expect(rendered).toContain("http://127.0.0.1:4319/ingest/session-1");
    }
  });

  test("sessions render a compact table without daemon terminology", () => {
    const rendered = renderPretty(commandFixtures.sessions);
    expect(rendered).toContain("SESSION ID");
    expect(rendered).toContain("session-1");
    expect(rendered).not.toContain("daemon");
  });

  for (const command of [
    "create",
    "template",
    "reset",
    "logs",
    "query",
    "status",
    "sessions",
    "clean",
    "stop",
  ]) {
    test(`${command} has pretty and JSON contracts`, () => {
      const pretty = renderFixture(command, false);
      expect(pretty.length).toBeGreaterThan(0);
      expect(pretty).not.toContain("daemon");

      const parsed = JSON.parse(renderFixture(command, true));
      expect(parsed).toMatchObject({ command, ok: true, schemaVersion: 1 });
    });
  }
});
