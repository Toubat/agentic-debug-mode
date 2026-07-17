import packageJson from "../../package.json";
import { clearCommand } from "../commands/clear";
import { daemonStopCommand } from "../commands/daemon-stop";
import { logsCommand } from "../commands/logs";
import { probeCommand } from "../commands/probe";
import { queryCommand } from "../commands/query";
import { runBeginCommand } from "../commands/run";
import { sessionsCommand } from "../commands/sessions";
import { startCommand } from "../commands/start";
import { statusCommand } from "../commands/status";
import { stopCommand } from "../commands/stop";
import type { CommandOutput } from "./output-schema";
import type { ParsedArgs } from "./parse-args";

export async function dispatch(args: ParsedArgs): Promise<CommandOutput> {
  if (args.options.version === true) {
    return {
      command: "version",
      data: { version: packageJson.version },
      hints: [],
      ok: true,
      partial: false,
      schemaVersion: 1,
      scope: {},
      statistics: {},
      warnings: [],
    };
  }

  if (args.command[0] === "start") {
    return startCommand(args);
  }
  if (args.command[0] === "logs") {
    return logsCommand(args);
  }
  if (args.command[0] === "query") {
    return queryCommand(args);
  }
  if (args.command[0] === "probe") {
    return probeCommand(args);
  }
  if (args.command[0] === "status") {
    return statusCommand(args);
  }
  if (args.command[0] === "clear") {
    return clearCommand(args);
  }
  if (args.command[0] === "run" && args.positionals[0] === "begin") {
    return runBeginCommand(args);
  }
  if (args.command[0] === "sessions") {
    return sessionsCommand(args);
  }
  if (args.command[0] === "stop") {
    return stopCommand(args);
  }
  if (args.command[0] === "daemon" && args.positionals[0] === "stop") {
    return daemonStopCommand();
  }

  return {
    error: {
      code: "INVALID_ARGUMENTS",
      hint: "Run debug-mode --help for usage.",
      message: args.command[0]
        ? `Unknown command: ${args.command.join(" ")}`
        : "A command is required.",
    },
    ok: false,
    schemaVersion: 1,
  };
}
