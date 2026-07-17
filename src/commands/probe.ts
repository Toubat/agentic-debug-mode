import { requestDaemonControl } from "../cli/daemon-client";
import { ensureDaemon } from "../cli/daemon-manager";
import type { CommandOutput } from "../cli/output-schema";
import type { ParsedArgs } from "../cli/parse-args";
import { normalizeProbeLanguage, renderProbe } from "../probes/render";
import { optionString } from "./options";

interface ProbeResponse {
  ingestPath: string;
  ingestUrl: string;
  runId: string;
  sessionId: string;
}

export async function probeCommand(args: ParsedArgs): Promise<CommandOutput> {
  const sessionId = optionString(args.options, "session");
  const runId = optionString(args.options, "run-id");
  const language = optionString(args.options, "language");
  if (!sessionId || !runId || !language) {
    return {
      error: {
        code: "INVALID_ARGUMENTS",
        message: "Provide --session, --run-id, and a supported --language to render a probe.",
      },
      ok: false,
      schemaVersion: 1,
    };
  }
  try {
    normalizeProbeLanguage(language);
  } catch (error) {
    return {
      error: {
        code: "INVALID_ARGUMENTS",
        hint: "Supported languages: javascript, typescript, python.",
        message: error instanceof Error ? error.message : "The probe language is unsupported.",
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
      data: { instrumentation: renderProbe(language, probe) },
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
