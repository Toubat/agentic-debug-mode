import { requestDaemonControl } from "../cli/daemon-client";
import { ensureDaemon } from "../cli/daemon-manager";
import type { CommandOutput, Warning } from "../cli/output-schema";
import type { CliInvocation } from "../cli/program";
import { sessionPathSegment } from "../cli/session-path";
import { createQueryCursor, verifyQueryCursor } from "../cli/snapshot-cursor";
import { Persistence } from "../daemon/persistence";
import type { EvidenceDiagnostic } from "../domain/diagnostic";
import { QueryTimeoutError, runJaqFilePage } from "../native/query";
import { commandError } from "./errors";

type QueryOptions = Extract<CliInvocation["command"], { kind: "query" }>;

interface QueryInputResponse {
  diagnostics: EvidenceDiagnostic[];
  eventCount: number;
  watermark: number;
}

function queryWarnings(diagnostics: EvidenceDiagnostic[]): Warning[] {
  const malformed = diagnostics.filter(
    (item) => item.reason === "INVALID_JSON" || item.reason === "INVALID_SCHEMA",
  ).length;
  const warnings: Warning[] = [];
  if (malformed > 0) {
    warnings.push({
      code: "MALFORMED_RECORDS",
      message: `${malformed} malformed records were excluded; run debug-mode status for diagnostics.`,
    });
  }
  return warnings;
}

export async function queryCommand(options: QueryOptions): Promise<CommandOutput> {
  const { cursor: requestedCursor, program: requestedProgram, sessionId } = options;
  if ((!requestedProgram && !requestedCursor) || (requestedProgram?.length ?? 0) > 4_096) {
    return {
      error: {
        code: "INVALID_ARGUMENTS",
        hint: "Provide --session and one bounded jaq program.",
        message: "The query command is missing a valid scope or program.",
      },
      ok: false,
      schemaVersion: 1,
    };
  }

  let program = requestedProgram ?? "";
  let slurp = options.slurp;
  try {
    const sessionPath = sessionPathSegment(sessionId);
    const startedAt = performance.now();
    const daemon = await ensureDaemon({
      homeDirectory: process.env.AGENT_DEBUG_MODE_HOME_OVERRIDE,
    });
    const input = await requestDaemonControl<QueryInputResponse>(
      daemon,
      `/v1/control/sessions/${sessionPath}/status`,
    );
    let hypothesisFilter: string[] = [];
    let watermark = input.watermark;
    let offset = 0;
    let limit = options.limit;
    if (requestedCursor) {
      const cursor = verifyQueryCursor(daemon.controlToken, requestedCursor, { sessionId });
      if (requestedProgram && requestedProgram !== cursor.program) {
        throw new Error("Query cursor program does not match the requested program");
      }
      program = cursor.program;
      slurp = cursor.slurp;
      hypothesisFilter = cursor.hypotheses;
      watermark = cursor.watermark;
      offset = cursor.offset;
      limit = cursor.limit;
    }
    const timeoutMilliseconds = options.timeoutMs;
    const persistence = await Persistence.open(process.env.AGENT_DEBUG_MODE_HOME_OVERRIDE);
    const query = runJaqFilePage(
      program,
      persistence.sessionFile(sessionId, "events.ndjson"),
      hypothesisFilter,
      watermark,
      offset,
      limit,
      slurp,
      timeoutMilliseconds,
    );
    const rows = query.results;
    const warnings = queryWarnings(input.diagnostics);
    const nextCursor = query.hasNext
      ? createQueryCursor(daemon.controlToken, {
          hypotheses: hypothesisFilter,
          issuedAt: Date.now(),
          limit,
          offset: offset + query.returnedRecords,
          program,
          sessionId,
          slurp,
          watermark,
        })
      : undefined;
    const hints =
      warnings.length === 0
        ? []
        : [
            {
              action: "status",
              command: `debug-mode status --session ${sessionId}`,
              message: "Inspect all evidence diagnostics.",
            },
          ];
    if (nextCursor) {
      hints.push({
        action: "next-page",
        command: `debug-mode query --session ${sessionId} --cursor ${nextCursor}`,
        message: "Continue the same query.",
      });
    }
    return {
      command: "query",
      data: {
        mode: slurp ? "slurp" : "streaming",
        pagination: {
          hasNext: query.hasNext,
          ...(nextCursor ? { nextCursor } : {}),
        },
        rows,
        slurp,
      },
      hints,
      ok: true,
      partial: false,
      schemaVersion: 1,
      scope: {
        hypothesisFilter: hypothesisFilter.length === 0 ? null : hypothesisFilter,
        sessionId,
      },
      statistics: {
        durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
        malformedRecords: input.diagnostics.filter(
          (item) => item.reason === "INVALID_JSON" || item.reason === "INVALID_SCHEMA",
        ).length,
        mode: slurp ? "slurp" : "streaming",
        producedValues: query.producedValues,
        returnedRecords: query.returnedRecords,
        scannedRecords: query.scannedRecords,
        totalRecords:
          input.eventCount +
          input.diagnostics.filter(
            (item) => item.reason === "INVALID_JSON" || item.reason === "INVALID_SCHEMA",
          ).length,
        validRecords: input.eventCount,
      },
      warnings,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "The jaq query failed.";
    if (error instanceof QueryTimeoutError) {
      return {
        error: {
          code: "QUERY_RESOURCE_EXHAUSTED",
          hint: "Narrow the filter, lower --limit, or increase --timeout-ms.",
          message,
        },
        ok: false,
        schemaVersion: 1,
      };
    }
    if (
      !slurp &&
      /\b(sort_by|group_by|reduce)\b/.test(program) &&
      /array|iterate|index|cannot|expected|invalid|runtime/i.test(message)
    ) {
      return {
        error: {
          code: "COLLECTION_REQUIRED",
          hint: `Re-run with --slurp: debug-mode query --session ${sessionId} --slurp ${JSON.stringify(program)}`,
          message: "This jaq program requires the complete record collection.",
        },
        ok: false,
        schemaVersion: 1,
      };
    }
    return commandError(error, "INVALID_ARGUMENTS", "The jaq query failed.");
  }
}
