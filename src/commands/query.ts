import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { requestDaemonControl } from "../cli/daemon-client";
import { ensureDaemon } from "../cli/daemon-manager";
import type { CommandOutput, Warning } from "../cli/output-schema";
import type { CliInvocation } from "../cli/program";
import { sessionPathSegment } from "../cli/session-path";
import {
  createQueryCursor,
  type QueryContinuation,
  QueryCursorStaleError,
  verifyQueryCursor,
} from "../cli/snapshot-cursor";
import { Persistence } from "../daemon/persistence";
import type { EvidenceDiagnostic } from "../domain/diagnostic";
import type { Session } from "../domain/session";
import {
  EvidenceMalformedError,
  type PagedFileQueryResult,
  QuerySpoolUnavailableError,
  QueryTimeoutError,
  runJaqFilePage,
  runJaqSlurpPage,
} from "../native/query";
import { commandError } from "./errors";

type QueryOptions = Extract<CliInvocation["command"], { kind: "query" }>;

interface QueryInputResponse {
  diagnostics: EvidenceDiagnostic[];
  eventCount: number;
  session: Session;
  watermark: number;
}

export interface QueryCommandTestHooks {
  afterNative?: () => Promise<void> | void;
  afterPreflight?: () => Promise<void> | void;
  executeNative?: (
    execute: () => PagedFileQueryResult,
  ) => Promise<PagedFileQueryResult> | PagedFileQueryResult;
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
  const redacted = diagnostics.filter((item) => item.reason === "SECRET_REDACTED").length;
  if (redacted > 0) {
    warnings.push({
      code: "SECRET_REDACTED",
      message: `${redacted} events contained fields that were redacted.`,
    });
  }
  return warnings;
}

function nextPageCommand(
  sessionId: string,
  cursor: string,
  limit: number,
  timeoutMs: number,
  slurp: boolean,
  json: boolean,
): string {
  const parts = [
    "debug-mode query",
    `--session ${sessionId}`,
    `--cursor ${cursor}`,
    `--limit ${limit}`,
    `--timeout-ms ${timeoutMs}`,
  ];
  if (slurp) {
    parts.push("--slurp");
  }
  if (json) {
    parts.push("--json");
  }
  return parts.join(" ");
}

export async function queryCommand(
  options: QueryOptions,
  json: boolean,
  testHooks: QueryCommandTestHooks = {},
): Promise<CommandOutput> {
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
  let spoolPath: string | undefined;
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
    let limit = options.limit;
    let timeoutMilliseconds = options.timeoutMs;
    let jsonRequested = json;
    let continuation: QueryContinuation = {
      byteOffset: 0,
      kind: "stream",
      outputOrdinal: 0,
    };
    if (requestedCursor) {
      const cursor = verifyQueryCursor(daemon.controlToken, requestedCursor, {
        evidenceEpoch: input.session.evidenceEpoch,
        sessionId,
      });
      if (requestedProgram && requestedProgram !== cursor.program) {
        throw new Error("Query cursor program does not match the requested program");
      }
      program = cursor.program;
      slurp = cursor.slurp;
      hypothesisFilter = cursor.hypotheses;
      watermark = cursor.watermark;
      limit = cursor.limit;
      timeoutMilliseconds = cursor.timeoutMs;
      jsonRequested = cursor.json;
      continuation = cursor.continuation;
    }
    await testHooks.afterPreflight?.();
    const persistence = await Persistence.open(process.env.AGENT_DEBUG_MODE_HOME_OVERRIDE);
    const evidencePath = persistence.sessionFile(sessionId, "events.ndjson");
    let spoolId: string | undefined;
    let spoolByteOffset = 0;
    if (slurp) {
      spoolId = continuation.kind === "spool" ? continuation.spoolId : randomUUID();
      spoolByteOffset = continuation.kind === "spool" ? continuation.byteOffset : 0;
      await persistence.initializeQuerySpoolDirectory(sessionId);
      spoolPath = persistence.querySpoolFile(sessionId, spoolId);
    }
    const executeNative = (): PagedFileQueryResult => {
      if (slurp) {
        return runJaqSlurpPage(
          program,
          evidencePath,
          hypothesisFilter,
          watermark,
          spoolPath as string,
          spoolByteOffset,
          limit,
          timeoutMilliseconds,
        );
      }
      const streamContinuation =
        continuation.kind === "stream"
          ? continuation
          : { byteOffset: 0, kind: "stream" as const, outputOrdinal: 0 };
      return runJaqFilePage(
        program,
        evidencePath,
        hypothesisFilter,
        watermark,
        streamContinuation.byteOffset,
        streamContinuation.outputOrdinal,
        limit,
        timeoutMilliseconds,
      );
    };
    let page: PagedFileQueryResult | undefined;
    let nativeError: unknown;
    try {
      page = testHooks.executeNative
        ? await testHooks.executeNative(executeNative)
        : executeNative();
    } catch (error) {
      nativeError = error;
    }
    await testHooks.afterNative?.();
    const postflight = await requestDaemonControl<QueryInputResponse>(
      daemon,
      `/v1/control/sessions/${sessionPath}/status`,
    );
    if (postflight.session.evidenceEpoch !== input.session.evidenceEpoch) {
      throw new QueryCursorStaleError();
    }
    if (nativeError !== undefined) {
      throw nativeError;
    }
    if (!page) {
      throw new Error("Native query returned no page.");
    }
    const rows = page.results;
    const warnings = queryWarnings(input.diagnostics);
    const nextContinuation: QueryContinuation | undefined =
      page.nextByteOffset === undefined
        ? undefined
        : slurp
          ? {
              byteOffset: page.nextByteOffset,
              kind: "spool",
              spoolId: spoolId as string,
            }
          : {
              byteOffset: page.nextByteOffset,
              kind: "stream",
              outputOrdinal: page.nextOutputOrdinal ?? 0,
            };
    const nextCursor = nextContinuation
      ? createQueryCursor(daemon.controlToken, {
          continuation: nextContinuation,
          evidenceEpoch: input.session.evidenceEpoch,
          hypotheses: hypothesisFilter,
          issuedAt: Date.now(),
          json: jsonRequested,
          limit,
          program,
          sessionId,
          slurp,
          timeoutMs: timeoutMilliseconds,
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
        command: nextPageCommand(
          sessionId,
          nextCursor,
          limit,
          timeoutMilliseconds,
          slurp,
          jsonRequested,
        ),
        message: "Continue the same query.",
      });
    } else if (spoolPath) {
      await rm(spoolPath, { force: true });
    }
    return {
      command: "query",
      data: {
        mode: slurp ? "slurp" : "streaming",
        pagination: {
          hasNext: page.hasNext,
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
        producedValues: page.producedValues,
        returnedRecords: page.returnedRecords,
        scannedRecords: page.scannedRecords,
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
    if (
      spoolPath &&
      (error instanceof EvidenceMalformedError ||
        error instanceof QueryCursorStaleError ||
        error instanceof QueryTimeoutError)
    ) {
      await rm(spoolPath, { force: true });
    }
    const message = error instanceof Error ? error.message : "The jaq query failed.";
    if (error instanceof QueryTimeoutError || error instanceof QuerySpoolUnavailableError) {
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
    if (error instanceof EvidenceMalformedError) {
      return {
        error: {
          code: "EVIDENCE_MALFORMED",
          hint: "Reset the session after preserving any needed diagnostics, then reproduce.",
          message,
        },
        ok: false,
        schemaVersion: 1,
      };
    }
    if (error instanceof QueryCursorStaleError) {
      return {
        error: {
          code: error.code,
          hint: "Run the query again without --cursor.",
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
