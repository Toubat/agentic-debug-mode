import { requestDaemonControl } from "../cli/daemon-client";
import { ensureDaemon } from "../cli/daemon-manager";
import type { CommandOutput, Hint, Warning } from "../cli/output-schema";
import type { ParsedArgs } from "../cli/parse-args";
import type { EvidenceDiagnostic } from "../domain/diagnostic";
import type { NormalizedEvent } from "../domain/event";
import { optionInteger, optionString, optionStrings } from "./options";

interface LogsResponse {
  diagnostics: EvidenceDiagnostic[];
  events: NormalizedEvent[];
  runId: string;
  workspace: string;
}

function diagnosticsWarnings(diagnostics: EvidenceDiagnostic[]): Warning[] {
  const malformed = diagnostics.filter(
    (item) => item.reason === "INVALID_JSON" || item.reason === "INVALID_SCHEMA",
  ).length;
  const undeclared = diagnostics.filter(
    (item) => item.reason === "UNDECLARED_HYPOTHESIS_ID",
  ).length;
  const redacted = diagnostics.filter((item) => item.reason === "SECRET_REDACTED").length;
  const warnings: Warning[] = [];
  if (malformed > 0) {
    warnings.push({
      code: "MALFORMED_RECORDS",
      message: `${malformed} malformed records were excluded; run debug-mode status for diagnostics.`,
    });
  }
  if (undeclared > 0) {
    warnings.push({
      code: "UNDECLARED_HYPOTHESIS_ID",
      message: `${undeclared} events used undeclared hypothesis IDs.`,
    });
  }
  if (redacted > 0) {
    warnings.push({
      code: "SECRET_REDACTED",
      message: `${redacted} events contained fields that were redacted.`,
    });
  }
  return warnings;
}

function pageCommand(
  args: ParsedArgs,
  sessionId: string,
  runId: string,
  offset: number,
  limit: number,
): string {
  const parts = [
    "debug-mode logs",
    `--session ${sessionId}`,
    `--run-id ${runId}`,
    `--offset ${offset}`,
    `--limit ${limit}`,
  ];
  const workspace = optionString(args.options, "workspace");
  if (workspace) {
    parts.push(`--workspace ${JSON.stringify(workspace)}`);
  }
  for (const hypothesis of optionStrings(args.options, "hypothesis")) {
    parts.push(`--hypothesis ${hypothesis}`);
  }
  if (args.options.json === true) {
    parts.push("--json");
  }
  return parts.join(" ");
}

export async function logsCommand(args: ParsedArgs): Promise<CommandOutput> {
  const sessionId = optionString(args.options, "session");
  const runId = optionString(args.options, "run-id");
  const offset = optionInteger(args.options, "offset", 0);
  const limit = optionInteger(args.options, "limit", 100);
  if (!sessionId || !runId || offset === undefined || limit === undefined || limit < 1) {
    return {
      error: {
        code: "INVALID_ARGUMENTS",
        hint: "Provide --session, --run-id, a non-negative --offset, and a positive --limit.",
        message: "The logs command has invalid scope or pagination options.",
      },
      ok: false,
      schemaVersion: 1,
    };
  }

  try {
    const daemon = await ensureDaemon({
      homeDirectory: process.env.AGENT_DEBUG_MODE_HOME_OVERRIDE,
    });
    const response = await requestDaemonControl<LogsResponse>(
      daemon,
      `/v1/control/sessions/${sessionId}/logs?runId=${encodeURIComponent(runId)}`,
    );
    const workspace = optionString(args.options, "workspace");
    if (workspace && workspace !== response.workspace) {
      return {
        error: {
          code: "SESSION_NOT_FOUND",
          message: `Session ${sessionId} does not belong to workspace ${workspace}.`,
        },
        ok: false,
        schemaVersion: 1,
      };
    }
    const hypothesisFilter = optionStrings(args.options, "hypothesis");
    const filtered =
      hypothesisFilter.length === 0
        ? response.events
        : response.events.filter((event) => hypothesisFilter.includes(event.hypothesisId));
    const records = filtered.slice(offset, offset + limit);
    const hints: Hint[] = [];
    if (offset > 0) {
      const previousOffset = Math.max(0, offset - limit);
      hints.push({
        action: "previous-page",
        command: pageCommand(args, sessionId, runId, previousOffset, limit),
        message: "Read the previous page.",
      });
    }
    if (offset + records.length < filtered.length) {
      hints.push({
        action: "next-page",
        command: pageCommand(args, sessionId, runId, offset + limit, limit),
        message: "Read the next page.",
      });
    }
    if (response.diagnostics.length > 0) {
      hints.push({
        action: "status",
        command: `debug-mode status --session ${sessionId} --run-id ${runId}`,
        message: "Inspect all malformed and abnormal evidence diagnostics.",
      });
    }
    return {
      command: "logs",
      data: { records },
      hints,
      ok: true,
      partial: false,
      schemaVersion: 1,
      scope: {
        hypothesisFilter: hypothesisFilter.length === 0 ? null : hypothesisFilter,
        runId,
        sessionId,
      },
      statistics: {
        limit,
        malformedRecords: response.diagnostics.filter(
          (item) => item.reason === "INVALID_JSON" || item.reason === "INVALID_SCHEMA",
        ).length,
        offset,
        returnedRecords: records.length,
        totalRecords: filtered.length,
        validRecords: response.events.length,
      },
      warnings: diagnosticsWarnings(response.diagnostics),
    };
  } catch (error) {
    return {
      error: {
        code: "SESSION_NOT_FOUND",
        message: error instanceof Error ? error.message : "The session was not found.",
      },
      ok: false,
      schemaVersion: 1,
    };
  }
}
