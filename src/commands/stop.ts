import {
  readDaemonHealth,
  requestDaemonControl,
  requestDaemonShutdown,
} from "../cli/daemon-client";
import { ensureDaemon } from "../cli/daemon-manager";
import type { CommandOutput } from "../cli/output-schema";
import type { ParsedArgs } from "../cli/parse-args";
import { optionString } from "./options";

export async function stopCommand(args: ParsedArgs): Promise<CommandOutput> {
  const sessionId = optionString(args.options, "session");
  if (!sessionId) {
    return {
      error: {
        code: "INVALID_ARGUMENTS",
        message: "Provide an explicit --session option.",
      },
      ok: false,
      schemaVersion: 1,
    };
  }
  try {
    const daemon = await ensureDaemon({
      homeDirectory: process.env.AGENT_DEBUG_MODE_HOME_OVERRIDE,
    });
    await requestDaemonControl(daemon, `/v1/control/sessions/${sessionId}/stop`, {
      body: "{}",
      method: "POST",
    });
    const health = await readDaemonHealth(daemon);
    const shouldStopDaemon = (health?.activeSessions ?? 0) === 0;
    if (shouldStopDaemon) {
      await requestDaemonShutdown(daemon);
    }
    return {
      command: "stop",
      data: {
        daemon: { status: shouldStopDaemon ? "stopped" : "running" },
        session: { status: "closed" },
      },
      hints: [],
      ok: true,
      partial: false,
      schemaVersion: 1,
      scope: { sessionId },
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
