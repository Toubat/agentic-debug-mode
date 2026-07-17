import { requestDaemonControl } from "../cli/daemon-client";
import { ensureDaemon } from "../cli/daemon-manager";
import type { CommandOutput, Hint, Warning } from "../cli/output-schema";
import type { CliInvocation } from "../cli/program";
import { sessionPathSegment } from "../cli/session-path";
import { createSnapshotCursor, verifySnapshotCursor } from "../cli/snapshot-cursor";
import type { EvidenceDiagnostic } from "../domain/diagnostic";
import type { NormalizedEvent } from "../domain/event";
import { commandError } from "./errors";

type LogsOptions = Extract<CliInvocation["command"], { kind: "logs" }>;

interface LogsResponse {
  diagnostics: EvidenceDiagnostic[];
  records: NormalizedEvent[];
  recordsByHypothesis: Record<string, number>;
  totalRecords: number;
  watermark: number;
}

function diagnosticsWarnings(diagnostics: EvidenceDiagnostic[]): Warning[] {
  const malformed = diagnostics.filter(
    (item) => item.reason === "INVALID_JSON" || item.reason === "INVALID_SCHEMA",
  ).length;
  const redacted = diagnostics.filter((item) => item.reason === "SECRET_REDACTED").length;
  const warnings: Warning[] = [];
  if (malformed > 0) {
    warnings.push({
      code: "MALFORMED_RECORDS",
      message: `${malformed} malformed records were excluded; run debug-mode status for diagnostics.`,
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
  options: LogsOptions,
  json: boolean,
  sessionId: string,
  offset: number,
  limit: number,
  snapshot: string,
): string {
  const parts = [
    "debug-mode logs",
    `--session ${sessionId}`,
    `--offset ${offset}`,
    `--limit ${limit}`,
    `--snapshot ${snapshot}`,
  ];
  for (const hypothesis of options.hypotheses) {
    parts.push(`--hypothesis ${hypothesis}`);
  }
  if (json) {
    parts.push("--json");
  }
  return parts.join(" ");
}

export async function logsCommand(options: LogsOptions, json: boolean): Promise<CommandOutput> {
  const sessionId = options.sessionId;
  const offset = options.offset;
  const limit = options.limit;
  if (!sessionId || offset === undefined || limit === undefined || limit < 1) {
    return {
      error: {
        code: "INVALID_ARGUMENTS",
        hint: "Provide --session, a non-negative --offset, and a positive --limit.",
        message: "The logs command has invalid scope or pagination options.",
      },
      ok: false,
      schemaVersion: 1,
    };
  }

  try {
    const daemon = await ensureDaemon({
    const sessionPath = sessionPathSegment(sessionId);
      homeDirectory: process.env.AGENT_DEBUG_MODE_HOME_OVERRIDE,
    });
    const hypothesisFilter = options.hypotheses;
    const requestedSnapshot = options.snapshot;
    const requestedWatermark = requestedSnapshot
      ? verifySnapshotCursor(daemon.controlToken, requestedSnapshot, {
          sessionId,
        }).watermark
      : undefined;
    const search = new URLSearchParams({
      limit: String(limit),
      offset: String(offset),
    });
    for (const hypothesisId of hypothesisFilter) {
      search.append("hypothesis", hypothesisId);
    }
    if (requestedWatermark !== undefined) {
      search.set("watermark", String(requestedWatermark));
    }
    const response = await requestDaemonControl<LogsResponse>(
      daemon,
      `/v1/control/sessions/${sessionPath}/logs?${search}`,
    );
    const watermark = requestedWatermark ?? response.watermark;
    const snapshot =
      requestedSnapshot ??
      createSnapshotCursor(daemon.controlToken, {
        issuedAt: Date.now(),
        sessionId,
        watermark,
      });
    const records = response.records;
    const malformedRecords = response.diagnostics.filter(
      (item) => item.reason === "INVALID_JSON" || item.reason === "INVALID_SCHEMA",
    ).length;
    const recordsByHypothesis = response.recordsByHypothesis;
    const hasPrevious = offset > 0;
    const hasNext = offset + records.length < response.totalRecords;
    const hints: Hint[] = [];
    if (hasPrevious) {
      const previousOffset = Math.max(0, offset - limit);
      hints.push({
        action: "previous-page",
        command: pageCommand(options, json, sessionId, previousOffset, limit, snapshot),
        message: "Read the previous page.",
      });
    }
    if (hasNext) {
      hints.push({
        action: "next-page",
        command: pageCommand(options, json, sessionId, offset + limit, limit, snapshot),
        message: "Read the next page.",
      });
    }
    if (response.diagnostics.length > 0) {
      hints.push({
        action: "status",
        command: `debug-mode status --session ${sessionId}`,
        message: "Inspect all malformed and abnormal evidence diagnostics.",
      });
    }
    return {
      command: "logs",
      data: {
        mode: "streaming",
        pagination: {
          hasNext,
          hasPrevious,
          limit,
          ...(hasNext ? { nextOffset: offset + limit } : {}),
          offset,
          ...(hasPrevious ? { previousOffset: Math.max(0, offset - limit) } : {}),
          snapshot,
        },
        records,
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
        limit,
        malformedRecords,
        offset,
        recordsByHypothesis,
        returnedRecords: records.length,
        totalRecords: response.totalRecords + malformedRecords,
        validRecords: response.totalRecords,
      },
      warnings: diagnosticsWarnings(response.diagnostics),
    };
  } catch (error) {
    return commandError(error, "SESSION_NOT_FOUND", "The session was not found.");
  }
}
