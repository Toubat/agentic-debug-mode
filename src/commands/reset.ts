import { requestDaemonControl } from "../cli/daemon-client";
import { ensureDaemon } from "../cli/daemon-manager";
import type { CommandOutput } from "../cli/output-schema";
import type { SessionIngest } from "./create";
import { commandError } from "./errors";

export async function resetCommand(sessionId: string): Promise<CommandOutput> {
  try {
    const daemon = await ensureDaemon({
      homeDirectory: process.env.AGENT_DEBUG_MODE_HOME_OVERRIDE,
    });
    const reset = await requestDaemonControl<SessionIngest>(
      daemon,
      `/v1/control/sessions/${sessionId}/reset`,
      { method: "POST" },
    );
    return {
      command: "reset",
      data: reset,
      hints: [],
      ok: true,
      partial: false,
      schemaVersion: 1,
      scope: { sessionId: reset.sessionId },
      statistics: {},
      warnings: [],
    };
  } catch (error) {
    return commandError(error, "DAEMON_UNAVAILABLE", "The hidden service is unavailable.");
  }
}
