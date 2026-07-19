import { requestDaemonShutdown } from "../cli/daemon-client";
import { ensureRecordedProcessGone, probeDaemonHealth } from "../cli/daemon-manager";
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
        // A daemon that answers a retried health probe is alive but refused
        // the shutdown; that failure must surface. A daemon that stays silent
        // is either already gone (stale state file, common on Windows) or
        // alive-but-unresponsive; verify by process identity and terminate it
        // when it still runs, so stop never reports success while the
        // recorded process survives and holds OS resources.
        if (await probeDaemonHealth(connection)) {
          throw error;
        }
        await ensureRecordedProcessGone(state);
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
