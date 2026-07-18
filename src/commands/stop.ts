import { readDaemonHealth, requestDaemonShutdown } from "../cli/daemon-client";
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
      const connection = { ...state, controlToken };
      try {
        await requestDaemonShutdown(connection);
      } catch (error) {
        // A recorded daemon that can no longer be reached has already exited
        // (common on Windows, where a stale state file can outlive the process).
        // Treat that as already stopped, but only when a health probe confirms
        // the daemon is truly gone — a daemon that is merely busy must still be
        // shut down so it does not leak and hold OS resources (e.g. a loaded
        // native addon that a subsequent build must overwrite).
        if (await readDaemonHealth(connection)) {
          throw error;
        }
      }
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
