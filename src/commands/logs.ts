import { requestDaemonControl } from "../cli/daemon-client";
import { ensureDaemon } from "../cli/daemon-manager";
import type { CommandOutput, Hint, Warning } from "../cli/output-schema";
import type { ParsedArgs } from "../cli/parse-args";
import { createSnapshotCursor, verifySnapshotCursor } from "../cli/snapshot-cursor";
import type { EvidenceDiagnostic } from "../domain/diagnostic";
import type { NormalizedEvent } from "../domain/event";
import { optionInteger, optionString, optionStrings } from "./options";

interface LogsResponse {
  diagnostics: EvidenceDiagnostic[];
  events: NormalizedEvent[];
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
  args: ParsedArgs,
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
  const offset = optionInteger(args.options, "offset", 0);
  const limit = optionInteger(args.options, "limit", 100);
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
      homeDirectory: process.env.AGENT_DEBUG_MODE_HOME_OVERRIDE,
    });
    const response = await requestDaemonControl<LogsResponse>(
      daemon,
      `/v1/control/sessions/${sessionId}/logs`,
    );
    const requestedSnapshot = optionString(args.options, "snapshot");
    const watermark = requestedSnapshot
      ? verifySnapshotCursor(daemon.controlToken, requestedSnapshot, {
          sessionId,
        }).watermark
      : response.events.reduce((maximum, event) => Math.max(maximum, event.sequence), 0);
    const snapshot =
      requestedSnapshot ??
      createSnapshotCursor(daemon.controlToken, {
        issuedAt: Date.now(),
        sessionId,
        watermark,
      });
    const snapshotEvents = response.events.filter((event) => event.sequence <= watermark);
    const hypothesisFilter = optionStrings(args.options, "hypothesis");
    const filtered =
      hypothesisFilter.length === 0
        ? snapshotEvents
        : snapshotEvents.filter((event) => hypothesisFilter.includes(event.hypothesisId));
    const records = filtered.slice(offset, offset + limit);
    const hints: Hint[] = [];
    if (offset > 0) {
      const previousOffset = Math.max(0, offset - limit);
      hints.push({
        action: "previous-page",
        command: pageCommand(args, sessionId, previousOffset, limit, snapshot),
        message: "Read the previous page.",
      });
    }
    if (offset + records.length < filtered.length) {
      hints.push({
        action: "next-page",
        command: pageCommand(args, sessionId, offset + limit, limit, snapshot),
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
      data: { records },
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
        malformedRecords: response.diagnostics.filter(
          (item) => item.reason === "INVALID_JSON" || item.reason === "INVALID_SCHEMA",
        ).length,
        offset,
        returnedRecords: records.length,
        snapshot,
        totalRecords: filtered.length,
        validRecords: snapshotEvents.length,
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
