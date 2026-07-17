import { requestDaemonControl } from "../cli/daemon-client";
import { ensureDaemon } from "../cli/daemon-manager";
import type { CommandOutput } from "../cli/output-schema";
import type { ParsedArgs } from "../cli/parse-args";
import { optionString, optionStrings } from "./options";

interface StatusResponse {
  hypothesisIds: string[];
  runId: string;
}

export async function runBeginCommand(args: ParsedArgs): Promise<CommandOutput> {
  const sessionId = optionString(args.options, "session");
  const runId = optionString(args.options, "run-id");
  if (!sessionId || !runId) {
    return {
      error: {
        code: "INVALID_ARGUMENTS",
        message: "Provide explicit --session and --run-id options.",
      },
      ok: false,
      schemaVersion: 1,
    };
  }
  try {
    const daemon = await ensureDaemon({
      homeDirectory: process.env.AGENT_DEBUG_MODE_HOME_OVERRIDE,
    });
    let hypothesisIds = optionStrings(args.options, "hypothesis");
    if (hypothesisIds.length === 0) {
      const status = await requestDaemonControl<StatusResponse>(
        daemon,
        `/v1/control/sessions/${sessionId}/status`,
      );
      hypothesisIds = status.hypothesisIds;
    }
    const run = await requestDaemonControl<{
      runId: string;
      sessionId: string;
    }>(daemon, `/v1/control/sessions/${sessionId}/runs`, {
      body: JSON.stringify({ hypothesisIds, runId }),
      method: "POST",
    });
    return {
      command: "run begin",
      data: { created: true },
      hints: [],
      ok: true,
      partial: false,
      schemaVersion: 1,
      scope: {
        hypothesisIds,
        runId: run.runId,
        sessionId: run.sessionId,
      },
      statistics: {},
      warnings: [],
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
