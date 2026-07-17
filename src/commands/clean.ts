import { requestDaemonControl } from "../cli/daemon-client";
import { ensureDaemon } from "../cli/daemon-manager";
import type { CommandOutput } from "../cli/output-schema";
import { sessionPathSegment } from "../cli/session-path";
import { commandError } from "./errors";

export async function cleanCommand(sessionId: string): Promise<CommandOutput> {
  try {
    const sessionPath = sessionPathSegment(sessionId);
    const daemon = await ensureDaemon({
      homeDirectory: process.env.AGENT_DEBUG_MODE_HOME_OVERRIDE,
    });
    const cleaned = await requestDaemonControl<{ removed: boolean; sessionId: string }>(
      daemon,
      `/v1/control/sessions/${sessionPath}`,
      { method: "DELETE" },
    );
    return {
      command: "clean",
      data: { removed: cleaned.removed },
      hints: [],
      ok: true,
      partial: false,
      schemaVersion: 1,
      scope: { sessionId: cleaned.sessionId },
      statistics: {},
      warnings: [],
    };
  } catch (error) {
    return commandError(error, "DAEMON_UNAVAILABLE", "The hidden service is unavailable.");
  }
}
