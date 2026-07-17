import { requestDaemonControl } from "../cli/daemon-client";
import { ensureDaemon } from "../cli/daemon-manager";
import type { CommandOutput, Warning } from "../cli/output-schema";
import type { CliInvocation } from "../cli/program";
import { runQueryWithTimeout } from "../cli/query-runner";
import { createSnapshotCursor, verifySnapshotCursor } from "../cli/snapshot-cursor";
import { Persistence } from "../daemon/persistence";
import type { EvidenceDiagnostic } from "../domain/diagnostic";

type QueryOptions = Extract<CliInvocation["command"], { kind: "query" }>;

interface QueryInputResponse {
  diagnostics: EvidenceDiagnostic[];
  eventCount: number;
  watermark: number;
}

export async function queryCommand(options: QueryOptions): Promise<CommandOutput> {
  const sessionId = options.sessionId;
  const program = options.program;
  if (!sessionId || !program || program.length > 4_096) {
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

  try {
    const startedAt = performance.now();
    const daemon = await ensureDaemon({
      homeDirectory: process.env.AGENT_DEBUG_MODE_HOME_OVERRIDE,
    });
    const input = await requestDaemonControl<QueryInputResponse>(
      daemon,
      `/v1/control/sessions/${sessionId}/status`,
    );
    const hypothesisFilter: string[] = [];
    const requestedSnapshot: string | undefined = undefined;
    const watermark = requestedSnapshot
      ? verifySnapshotCursor(daemon.controlToken, requestedSnapshot, {
          sessionId,
        }).watermark
      : input.watermark;
    const snapshot =
      requestedSnapshot ??
      createSnapshotCursor(daemon.controlToken, {
        issuedAt: Date.now(),
        sessionId,
        watermark,
      });
    const slurp = options.slurp;
    const timeoutMilliseconds = options.timeoutMs;
    if (timeoutMilliseconds === undefined || timeoutMilliseconds < 1) {
      return {
        error: {
          code: "INVALID_ARGUMENTS",
          message: "--timeout-ms must be a positive integer.",
        },
        ok: false,
        schemaVersion: 1,
      };
    }
    const persistence = await Persistence.open(process.env.AGENT_DEBUG_MODE_HOME_OVERRIDE);
    const query = await runQueryWithTimeout(
      {
        hypotheses: hypothesisFilter,
        path: persistence.sessionFile(sessionId, "events.ndjson"),
        program,
        slurp,
        watermark,
      },
      timeoutMilliseconds,
    );
    const results = query.results;
    const warnings: Warning[] =
      input.diagnostics.length === 0
        ? []
        : [
            {
              code: "EVIDENCE_DIAGNOSTICS",
              message: `${input.diagnostics.length} malformed or abnormal records require status review.`,
            },
          ];
    return {
      command: "query",
      data: { results },
      hints:
        warnings.length === 0
          ? []
          : [
              {
                action: "status",
                command: `debug-mode status --session ${sessionId}`,
                message: "Inspect all evidence diagnostics.",
              },
            ],
      ok: true,
      partial: false,
      schemaVersion: 1,
      scope: {
        hypothesisFilter: hypothesisFilter.length === 0 ? null : hypothesisFilter,
        sessionId,
      },
      statistics: {
        durationMilliseconds: Math.round((performance.now() - startedAt) * 100) / 100,
        malformedRecords: input.diagnostics.filter(
          (item) => item.reason === "INVALID_JSON" || item.reason === "INVALID_SCHEMA",
        ).length,
        mode: slurp ? "slurp" : "streaming",
        outputValues: results.length,
        scannedRecords: query.scannedRecords,
        snapshot,
        totalRecords: query.totalRecords,
      },
      warnings,
    };
  } catch (error) {
    return {
      error: {
        code: "INVALID_ARGUMENTS",
        hint: "Check jaq syntax and use --slurp for whole-array operations.",
        message: error instanceof Error ? error.message : "The jaq query failed.",
      },
      ok: false,
      schemaVersion: 1,
    };
  }
}
