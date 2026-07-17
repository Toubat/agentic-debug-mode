import { requestDaemonControl } from "../cli/daemon-client";
import { ensureDaemon } from "../cli/daemon-manager";
import type { CommandOutput } from "../cli/output-schema";
import type { ParsedArgs } from "../cli/parse-args";
import { renderTypeScriptProbe } from "../probes/typescript";
import { optionString } from "./options";

interface ProbeResponse {
  ingestUrl: string;
  runId: string;
  sessionId: string;
}

export async function probeCommand(args: ParsedArgs): Promise<CommandOutput> {
  const sessionId = optionString(args.options, "session");
  const runId = optionString(args.options, "run-id");
  const language = optionString(args.options, "language");
  if (!sessionId || !runId || (language !== "typescript" && language !== "ts")) {
    return {
      error: {
        code: "INVALID_ARGUMENTS",
        message: "Provide --session, --run-id, and --language typescript to render a probe.",
      },
      ok: false,
      schemaVersion: 1,
    };
  }
  try {
    const daemon = await ensureDaemon({
      homeDirectory: process.env.AGENT_DEBUG_MODE_HOME_OVERRIDE,
    });
    const probe = await requestDaemonControl<ProbeResponse>(
      daemon,
      `/v1/control/sessions/${sessionId}/probe?runId=${encodeURIComponent(runId)}`,
    );
    return {
      command: "probe",
      data: { instrumentation: renderTypeScriptProbe(probe) },
      hints: [],
      ok: true,
      partial: false,
      schemaVersion: 1,
      scope: { runId, sessionId },
      statistics: {},
      warnings: [],
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
