import { daemonStopCommand } from "../commands/daemon-stop";
import { logsCommand } from "../commands/logs";
import { queryCommand } from "../commands/query";
import { sessionsCommand } from "../commands/sessions";
import { statusCommand } from "../commands/status";
import type { CommandOutput } from "./output-schema";
import type { CliInvocation } from "./program";

function pendingCommand(command: "create" | "template" | "reset" | "clean"): CommandOutput {
  return {
    error: {
      code: "INVALID_ARGUMENTS",
      message: `The ${command} command handler is not available yet.`,
    },
    ok: false,
    schemaVersion: 1,
  };
}

export async function dispatch(invocation: CliInvocation): Promise<CommandOutput> {
  const command = invocation.command;
  switch (command.kind) {
    case "create":
      return pendingCommand(command.kind);
    case "template":
      return pendingCommand(command.kind);
    case "reset":
      return pendingCommand(command.kind);
    case "logs":
      return logsCommand(command, invocation.json);
    case "query":
      return queryCommand(command);
    case "status":
      return statusCommand(command.sessionId);
    case "sessions":
      return sessionsCommand(command.all);
    case "clean":
      return pendingCommand(command.kind);
    case "stop":
      return daemonStopCommand();
    default: {
      const exhaustive: never = command;
      return exhaustive;
    }
  }
}
