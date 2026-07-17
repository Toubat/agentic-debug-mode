import packageJson from "../../package.json";
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
