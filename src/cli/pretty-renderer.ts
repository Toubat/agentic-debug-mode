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

function renderData(result: CommandResult): string[] {
  if (result.data === null || typeof result.data !== "object" || Array.isArray(result.data)) {
    return renderValue(result.data);
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

  const summary = [output.command.toUpperCase()];
  const scope = renderScope(output);
  if (scope) {
    summary.push(scope);
  }
  summary.push(...renderStatistics(output));
  sections.push(summary);
  sections.push(renderData(output));

  if (output.hints.length > 0) {
    sections.push(output.hints.flatMap(renderHint));
  }

  return sections.map((section) => section.join("\n")).join("\n\n");
}
