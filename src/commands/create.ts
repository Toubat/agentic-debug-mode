import { requestDaemonControl } from "../cli/daemon-client";
import { type EnsureDaemonFunction, ensureDaemon } from "../cli/daemon-manager";
import type { CommandOutput } from "../cli/output-schema";
import { commandError } from "./errors";

export interface SessionIngest {
  appendPath: string;
  ingestUrl: string;
  sessionId: string;
}

export async function createCommand(
  ensure: EnsureDaemonFunction = ensureDaemon,
): Promise<CommandOutput> {
  try {
    const daemon = await ensure({
      homeDirectory: process.env.AGENT_DEBUG_MODE_HOME_OVERRIDE,
    });
    const created = await requestDaemonControl<SessionIngest>(daemon, "/v1/control/sessions", {
      method: "POST",
    });
    return {
      command: "create",
      data: created,
      hints: [],
      ok: true,
      partial: false,
      schemaVersion: 1,
      scope: { sessionId: created.sessionId },
      statistics: {},
      warnings: [],
    };
  } catch (error) {
    return commandError(error, "DAEMON_UNAVAILABLE", "The hidden service is unavailable.");
  }
}
