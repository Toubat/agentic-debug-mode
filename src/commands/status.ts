import { requestDaemonControl } from "../cli/daemon-client";
import { type EnsureDaemonFunction, ensureDaemon } from "../cli/daemon-manager";
import type { CommandOutput, Warning } from "../cli/output-schema";
import { sessionPathSegment } from "../cli/session-path";
import type { EvidenceDiagnostic } from "../domain/diagnostic";
import type { Session } from "../domain/session";
import { commandError } from "./errors";

interface StatusResponse {
  diagnostics: EvidenceDiagnostic[];
  eventCount: number;
  session: Session;
}

export async function statusCommand(
  sessionId: string,
  ensure: EnsureDaemonFunction = ensureDaemon,
): Promise<CommandOutput> {
  try {
    const sessionPath = sessionPathSegment(sessionId);
    const daemon = await ensure({
      homeDirectory: process.env.AGENT_DEBUG_MODE_HOME_OVERRIDE,
    });
    const response = await requestDaemonControl<StatusResponse>(
      daemon,
      `/v1/control/sessions/${sessionPath}/status`,
    );
    const warnings: Warning[] =
      response.diagnostics.length === 0
        ? []
        : [
            {
              code: "EVIDENCE_DIAGNOSTICS",
              message: `${response.diagnostics.length} evidence diagnostics require attention.`,
            },
          ];
    return {
      command: "status",
      data: {
        diagnostics: response.diagnostics,
        session: response.session,
      },
      hints:
        response.diagnostics.length === 0
          ? []
          : [
              {
                action: "clear",
                command: `debug-mode clear --session ${sessionId}`,
                message: "Fix the listed emitters, clear this session, and reproduce.",
              },
            ],
      ok: true,
      partial: false,
      schemaVersion: 1,
      scope: {
        sessionId,
      },
      statistics: {
        diagnosticCount: response.diagnostics.length,
        eventCount: response.eventCount,
      },
      warnings,
    };
  } catch (error) {
    return commandError(error, "SESSION_NOT_FOUND", "The session was not found.");
  }
}
