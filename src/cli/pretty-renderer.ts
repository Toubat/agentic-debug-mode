import type { CommandError, CommandOutput, CommandResult, Hint } from "./output-schema";

function renderError(output: CommandError): string {
  const lines = [`ERROR  [${output.error.code}] ${output.error.message}`];
  if (output.error.hint) {
    lines.push("", `HINT  ${output.error.hint}`);
  }
  return lines.join("\n");
}

function renderScope(result: CommandResult): string | undefined {
  const parts: string[] = [];
  if (result.scope.sessionId) {
    parts.push(`Session ${result.scope.sessionId}`);
  }
  return parts.length > 0 ? parts.join("  •  ") : undefined;
}

function formatStatistic(value: CommandResult["statistics"][string]): string {
  if (value !== null && typeof value === "object") {
    const pairs = Object.entries(value).map(([name, count]) => `${name}=${count}`);
    return pairs.length > 0 ? pairs.join(", ") : "(none)";
  }
  return String(value);
}

function renderStatistics(result: CommandResult): string[] {
  const entries = Object.entries(result.statistics);
  const width = Math.max(0, ...entries.map(([key]) => key.length));
  return entries.map(([key, value]) => `${key.padEnd(width)}  ${formatStatistic(value)}`);
}

function renderValue(value: unknown, indentation = "  "): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) =>
      typeof item === "string"
        ? [`${indentation}${item}`]
        : JSON.stringify(item, null, 2)
            .split("\n")
            .map((line) => `${indentation}${line}`),
    );
  }
  if (typeof value === "string") {
    return [`${indentation}${value}`];
  }
  return JSON.stringify(value, null, 2)
    .split("\n")
    .map((line) => `${indentation}${line}`);
}

interface LogRecord {
  data: unknown;
  hypothesisId: string;
  id: string;
  location: string;
  message: string;
  receivedAt: number;
  sequence: number;
  timestamp: number;
}

function isLogRecord(value: unknown): value is LogRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === "string" &&
    typeof record.sequence === "number" &&
    typeof record.timestamp === "number" &&
    typeof record.receivedAt === "number" &&
    typeof record.hypothesisId === "string" &&
    typeof record.location === "string" &&
    typeof record.message === "string" &&
    "data" in record
  );
}

function formatTimestamp(timestamp: number): string {
  const date = new Date(timestamp);
  return Number.isNaN(date.valueOf()) ? String(timestamp) : date.toISOString();
}

function renderLogTable(records: LogRecord[]): string[] {
  if (records.length === 0) {
    return ["records", "  (none)"];
  }
  const headers = ["ID", "SEQ", "TIME", "RECEIVED", "HYP", "LOCATION", "MESSAGE", "DATA"];
  const rows = records.map((record) => [
    record.id,
    String(record.sequence),
    formatTimestamp(record.timestamp),
    formatTimestamp(record.receivedAt),
    record.hypothesisId,
    record.location,
    record.message,
    JSON.stringify(record.data),
  ]);
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => row[index]?.length ?? 0)),
  );
  const renderRow = (row: string[]) =>
    row
      .map((value, index) =>
        index === row.length - 1 ? value : value.padEnd(widths[index] ?? value.length),
      )
      .join("  ");
  return ["records", renderRow(headers), ...rows.map(renderRow)];
}

function isScalar(value: unknown): boolean {
  return (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string"
  );
}

function scalarText(value: unknown): string {
  return value === null ? "null" : String(value);
}

function scalarValueText(value: unknown): string {
  return typeof value === "string" ? JSON.stringify(value) : scalarText(value);
}

function renderRows(headers: string[], rows: string[][]): string[] {
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => row[index]?.length ?? 0)),
  );
  return [
    headers
      .map((header, index) =>
        index === headers.length - 1 ? header : header.padEnd(widths[index] ?? header.length),
      )
      .join("  "),
    ...rows.map((row) =>
      row
        .map((value, index) =>
          index === row.length - 1 ? value : value.padEnd(widths[index] ?? value.length),
        )
        .join("  "),
    ),
  ];
}

function renderQueryResults(results: unknown[]): string[] {
  if (results.length === 0) {
    return ["No values produced"];
  }
  if (results.every(isScalar)) {
    return [
      ...renderRows(
        ["INDEX", "VALUE"],
        results.map((value, index) => [String(index + 1), scalarValueText(value)]),
      ),
    ];
  }
  if (
    results.every(
      (value) =>
        value !== null &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        Object.values(value).every(isScalar),
    )
  ) {
    const objects = results as Array<Record<string, unknown>>;
    const keys = Object.keys(objects[0] ?? {});
    if (
      objects.every(
        (object) =>
          Object.keys(object).length === keys.length && keys.every((key) => key in object),
      )
    ) {
      return [
        ...renderRows(
          keys.map((key) => key.toUpperCase()),
          objects.map((object) => keys.map((key) => scalarText(object[key]))),
        ),
      ];
    }
  }
  return results.flatMap((value, index) => [
    `RESULT ${index + 1} OF ${results.length}`,
    ...JSON.stringify(value, null, 2).split("\n"),
  ]);
}

function renderIngestData(data: Record<string, unknown>): string[] {
  const lines: string[] = [];
  if (typeof data.ingestUrl === "string") {
    lines.push(`Ingest URL   ${data.ingestUrl}`);
  }
  if (typeof data.appendPath === "string") {
    lines.push(`Append Path  ${data.appendPath}`);
  }
  return lines.length > 0
    ? lines
    : Object.entries(data).flatMap(([key, value]) => [key, ...renderValue(value)]);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.values(value).every((entry) => typeof entry === "string")
  );
}

function renderTemplateData(data: Record<string, unknown>): string[] | undefined {
  const { callTemplate, eventSchema, helperTemplate, placeholders } = data;
  if (
    typeof helperTemplate !== "string" ||
    typeof callTemplate !== "string" ||
    !isStringRecord(placeholders) ||
    !isStringRecord(eventSchema)
  ) {
    return undefined;
  }
  const placeholderWidth = Math.max(0, ...Object.keys(placeholders).map((name) => name.length));
  return [
    "HELPER TEMPLATE",
    ...helperTemplate.split("\n"),
    "",
    "CALL TEMPLATE",
    ...callTemplate.split("\n"),
    "",
    "PLACEHOLDERS",
    ...Object.entries(placeholders).map(
      ([name, meaning]) => `${name.padEnd(placeholderWidth)}  ${meaning}`,
    ),
    "",
    "EVENT SCHEMA",
    ...Object.entries(eventSchema).map(([field, type]) => `${field}  ${type}`),
  ];
}

interface EvidenceHealth {
  daemon: string;
  ingestion: string;
  queryEngine: string;
}

interface StatusDiagnostic {
  diagnosticId: string;
  message: string;
  reason: string;
  recoverable: { hypothesisId?: string; location?: string };
  redactedPreview: string;
  suggestedAction: string;
}

function isEvidenceHealth(value: unknown): value is EvidenceHealth {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const health = value as Record<string, unknown>;
  return (
    typeof health.daemon === "string" &&
    typeof health.ingestion === "string" &&
    typeof health.queryEngine === "string"
  );
}

function renderStatusData(data: Record<string, unknown>): string[] | undefined {
  if (!isEvidenceHealth(data.health)) {
    return undefined;
  }
  const health = data.health;
  const lines = [
    `Service ${health.daemon}  •  Ingestion ${health.ingestion}  •  Query engine ${health.queryEngine}`,
  ];
  const diagnostics = Array.isArray(data.diagnostics)
    ? (data.diagnostics as StatusDiagnostic[])
    : [];
  if (diagnostics.length > 0) {
    lines.push("", "MALFORMED RECORDS");
    for (const diagnostic of diagnostics) {
      const source = [
        diagnostic.recoverable?.location,
        diagnostic.recoverable?.hypothesisId
          ? `Hypothesis ${diagnostic.recoverable.hypothesisId}`
          : undefined,
      ]
        .filter(Boolean)
        .join("  •  ");
      lines.push("", `  ${diagnostic.diagnosticId}  ${diagnostic.reason}`);
      if (source) {
        lines.push(`  Source    ${source}`);
      }
      lines.push(
        `  Problem   ${diagnostic.message}`,
        `  Preview   ${diagnostic.redactedPreview}`,
        `  Fix       ${diagnostic.suggestedAction}`,
      );
    }
  }
  return lines;
}

interface SessionSummary {
  createdAt: number;
  eventCount: number;
  id: string;
}

function isSessionSummary(value: unknown): value is SessionSummary {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const summary = value as Record<string, unknown>;
  return (
    typeof summary.id === "string" &&
    typeof summary.createdAt === "number" &&
    typeof summary.eventCount === "number"
  );
}

function renderSessionsData(data: Record<string, unknown>): string[] | undefined {
  if (!Array.isArray(data.sessions) || !data.sessions.every(isSessionSummary)) {
    return undefined;
  }
  const sessions = data.sessions as SessionSummary[];
  if (sessions.length === 0) {
    return ["No sessions"];
  }
  return renderRows(
    ["SESSION ID", "CREATED AT", "EVENTS"],
    sessions.map((session) => [
      session.id,
      formatTimestamp(session.createdAt),
      String(session.eventCount),
    ]),
  );
}

function renderData(result: CommandResult): string[] {
  if (result.data === null || typeof result.data !== "object" || Array.isArray(result.data)) {
    return renderValue(result.data);
  }
  const data = result.data as Record<string, unknown>;
  if (result.command === "create" || result.command === "reset") {
    return renderIngestData(data);
  }
  if (result.command === "template") {
    const rendered = renderTemplateData(data);
    if (rendered) {
      return rendered;
    }
  }
  if (result.command === "status") {
    const rendered = renderStatusData(data);
    if (rendered) {
      return rendered;
    }
  }
  if (result.command === "sessions") {
    const rendered = renderSessionsData(data);
    if (rendered) {
      return rendered;
    }
  }
  if (
    result.command === "logs" &&
    "records" in data &&
    Array.isArray(data.records) &&
    data.records.every(isLogRecord)
  ) {
    return renderLogTable(data.records);
  }
  if (result.command === "query" && "rows" in data && Array.isArray(data.rows)) {
    return renderQueryResults(data.rows);
  }

  return Object.entries(data).flatMap(([key, value]) => [key, ...renderValue(value)]);
}

function renderHint(hint: Hint): string[] {
  const lines = [`${hint.action.toUpperCase()}  ${hint.message}`];
  if (hint.command) {
    lines.push(`  ${hint.command}`);
  }
  return lines;
}

export function renderPretty(output: CommandOutput): string {
  if (!output.ok) {
    return renderError(output);
  }

  const sections: string[][] = [];
  if (output.warnings.length > 0) {
    sections.push(
      output.warnings.map((warning) => `WARNING  [${warning.code}] ${warning.message}`),
    );
  }

  const summary = [output.command === "create" ? "SESSION CREATED" : output.command.toUpperCase()];
  const scope = renderScope(output);
  if (scope) {
    summary.push(scope);
  }
  summary.push(...renderStatistics(output));
  sections.push(summary);
  if (output.command === "reset") {
    sections.push(["Sequence reset to 1"]);
  }
  sections.push(renderData(output));

  if (output.hints.length > 0) {
    sections.push(output.hints.flatMap(renderHint));
  }

  return sections.map((section) => section.join("\n")).join("\n\n");
}
