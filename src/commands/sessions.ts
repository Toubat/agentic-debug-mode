import { requestDaemonControl } from "../cli/daemon-client";
import { ensureDaemon } from "../cli/daemon-manager";
import type { CommandOutput } from "../cli/output-schema";
import { commandError } from "./errors";

interface SessionSummary {
  createdAt: number;
  eventCount: number;
  id: string;
}

export async function sessionsCommand(all: boolean): Promise<CommandOutput> {
  try {
    const daemon = await ensureDaemon({
      homeDirectory: process.env.AGENT_DEBUG_MODE_HOME_OVERRIDE,
    });
    const response = await requestDaemonControl<{ sessions: SessionSummary[] }>(
      daemon,
      `/v1/control/sessions?all=${String(all)}`,
    );
    const sessions = response.sessions;
    return {
      command: "sessions",
      data: { sessions },
      hints: [],
      ok: true,
      partial: false,
      schemaVersion: 1,
      scope: {},
      statistics: { sessionCount: sessions.length },
      warnings: [],
    };
  } catch (error) {
    return commandError(error, "DAEMON_UNAVAILABLE", "The daemon is unavailable.");
  }
}
