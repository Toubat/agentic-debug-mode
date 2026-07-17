import { requestDaemonShutdown } from "../cli/daemon-client";
import type { CommandOutput } from "../cli/output-schema";
import { getOrCreateControlToken } from "../daemon/auth";
import { Persistence } from "../daemon/persistence";
import { readDaemonState } from "../daemon/state-file";
import { commandError } from "./errors";

export async function stopCommand(): Promise<CommandOutput> {
  try {
    const persistence = await Persistence.open(process.env.AGENT_DEBUG_MODE_HOME_OVERRIDE);
    const state = await readDaemonState(persistence.stateRoot);
    if (state) {
      const controlToken = await getOrCreateControlToken(persistence.stateRoot);
      await requestDaemonShutdown({ ...state, controlToken });
    }
    return {
      command: "stop",
      data: { status: "stopped" },
      hints: [],
      ok: true,
      partial: false,
      schemaVersion: 1,
      scope: {},
      statistics: {},
      warnings: [],
    };
  } catch (error) {
    return commandError(error, "DAEMON_UNAVAILABLE", "The hidden service could not be stopped.");
  }
}
