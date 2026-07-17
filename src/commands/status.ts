import { requestDaemonControl } from "../cli/daemon-client";
import { ensureDaemon } from "../cli/daemon-manager";
import type { CommandOutput, Warning } from "../cli/output-schema";
import type { ParsedArgs } from "../cli/parse-args";
import type { EvidenceDiagnostic } from "../domain/diagnostic";
import type { Session } from "../domain/session";
import { optionString } from "./options";

interface StatusResponse {
  diagnostics: EvidenceDiagnostic[];
  eventCount: number;
  session: Session;
}

export async function statusCommand(args: ParsedArgs): Promise<CommandOutput> {
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
    const response = await requestDaemonControl<StatusResponse>(
      daemon,
      `/v1/control/sessions/${sessionId}/status`,
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
