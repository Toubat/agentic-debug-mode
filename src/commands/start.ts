import { requestDaemonControl } from "../cli/daemon-client";
import { ensureDaemon } from "../cli/daemon-manager";
import type { CommandOutput } from "../cli/output-schema";
import type { ParsedArgs } from "../cli/parse-args";
import { normalizeProbeLanguage, renderProbe } from "../probes/render";
import { optionString, optionStrings } from "./options";

interface CreatedSession {
  ingestPath: string;
  ingestUrl: string;
  runId: string;
  sessionId: string;
}

export async function startCommand(args: ParsedArgs): Promise<CommandOutput> {
  const workspace = optionString(args.options, "workspace");
  const language = optionString(args.options, "language");
  const runId = optionString(args.options, "run-id") ?? "baseline";
  const hypothesisIds = optionStrings(args.options, "hypothesis");
  if (!workspace || !language || hypothesisIds.length === 0) {
    return {
      error: {
        code: "INVALID_ARGUMENTS",
        hint: "Provide --workspace, a supported --language, and at least one --hypothesis.",
        message: "The start command is missing required options.",
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
    const created = await requestDaemonControl<CreatedSession>(daemon, "/v1/control/sessions", {
      body: JSON.stringify({ hypothesisIds, runId, workspace }),
      method: "POST",
    });
    return {
      command: "start",
      data: {
        capabilities: { liveEvents: true, ui: false },
        daemon: { status: "running" },
        instrumentation: renderProbe(language, created),
        workspace,
      },
      hints: [],
      ok: true,
      partial: false,
      schemaVersion: 1,
      scope: {
        hypothesisIds,
        runId: created.runId,
        sessionId: created.sessionId,
      },
      statistics: {},
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
