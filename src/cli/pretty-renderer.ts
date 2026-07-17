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
  if (result.scope.runId) {
    parts.push(`Run ${result.scope.runId}`);
  }
  return parts.length > 0 ? parts.join("  •  ") : undefined;
}

function renderStatistics(result: CommandResult): string[] {
  const entries = Object.entries(result.statistics);
  const width = Math.max(0, ...entries.map(([key]) => key.length));
  return entries.map(([key, value]) => `${key.padEnd(width)}  ${String(value)}`);
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
  schemaVersion: number;
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
    typeof record.schemaVersion === "number" &&
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
  const schemas = [...new Set(records.map((record) => record.schemaVersion))];
  return [
    `records  •  schemaVersion ${schemas.join(", ")}`,
    renderRow(headers),
    ...rows.map(renderRow),
  ];
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
    return ["results", "  (none)"];
  }
  if (results.every(isScalar)) {
    return [
      "results",
      ...renderRows(
        ["VALUE"],
        results.map((value) => [scalarText(value)]),
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
        "results",
        ...renderRows(
          keys.map((key) => key.toUpperCase()),
          objects.map((object) => keys.map((key) => scalarText(object[key]))),
        ),
      ];
    }
  }
  return ["results", ...renderValue(results)];
}

function renderData(result: CommandResult): string[] {
  if (result.data === null || typeof result.data !== "object" || Array.isArray(result.data)) {
    return renderValue(result.data);
  }
  if (
    result.command === "logs" &&
    "records" in result.data &&
    Array.isArray(result.data.records) &&
    result.data.records.every(isLogRecord)
  ) {
    return renderLogTable(result.data.records);
  }
  if (
    result.command === "query" &&
    "results" in result.data &&
    Array.isArray(result.data.results)
  ) {
    return renderQueryResults(result.data.results);
  }

  return Object.entries(result.data).flatMap(([key, value]) => [key, ...renderValue(value)]);
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
