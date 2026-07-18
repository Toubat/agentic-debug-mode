import { cleanCommand } from "../commands/clean";
import { createCommand } from "../commands/create";
import { logsCommand } from "../commands/logs";
import { queryCommand } from "../commands/query";
import { resetCommand } from "../commands/reset";
import { sessionsCommand } from "../commands/sessions";
import { statusCommand } from "../commands/status";
import { stopCommand } from "../commands/stop";
import type { CommandOutput } from "./output-schema";
import type { CliInvocation } from "./program";

function pendingCommand(command: "template"): CommandOutput {
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
      return createCommand();
    case "template":
      return pendingCommand(command.kind);
    case "reset":
      return resetCommand(command.sessionId);
    case "logs":
      return logsCommand(command, invocation.json);
    case "query":
      return queryCommand(command, invocation.json);
    case "status":
      return statusCommand(command.sessionId);
    case "sessions":
      return sessionsCommand(command.all);
    case "clean":
      return cleanCommand(command.sessionId);
    case "stop":
      return stopCommand();
    default: {
      const exhaustive: never = command;
      return exhaustive;
    }
  }
}
