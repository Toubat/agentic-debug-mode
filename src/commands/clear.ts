import { requestDaemonControl } from "../cli/daemon-client";
import { ensureDaemon } from "../cli/daemon-manager";
import type { CommandOutput } from "../cli/output-schema";
import type { ParsedArgs } from "../cli/parse-args";
import { optionString } from "./options";

export async function clearCommand(args: ParsedArgs): Promise<CommandOutput> {
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
    await requestDaemonControl(daemon, `/v1/control/sessions/${sessionId}/clear`, {
      body: JSON.stringify({ runId }),
      method: "POST",
    });
    return {
      command: "clear",
      data: { cleared: true },
      hints: [],
      ok: true,
      partial: false,
      schemaVersion: 1,
      scope: { runId, sessionId },
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
