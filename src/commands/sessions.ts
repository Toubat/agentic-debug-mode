import { requestDaemonControl } from "../cli/daemon-client";
import { ensureDaemon } from "../cli/daemon-manager";
import type { CommandOutput } from "../cli/output-schema";
import type { ParsedArgs } from "../cli/parse-args";
import type { Session } from "../domain/session";
import { optionString } from "./options";

type PublicSession = Omit<Session, "ingestCapability">;

export async function sessionsCommand(args: ParsedArgs): Promise<CommandOutput> {
  try {
    const daemon = await ensureDaemon({
      homeDirectory: process.env.AGENT_DEBUG_MODE_HOME_OVERRIDE,
    });
    const response = await requestDaemonControl<{ sessions: PublicSession[] }>(
      daemon,
      "/v1/control/sessions",
    );
    const workspace = optionString(args.options, "workspace");
    const sessions = workspace
      ? response.sessions.filter((session) => session.workspace === workspace)
      : response.sessions;
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
    return {
      error: {
        code: "DAEMON_UNAVAILABLE",
        message: error instanceof Error ? error.message : "The daemon is unavailable.",
      },
      ok: false,
      schemaVersion: 1,
    };
  }
}
