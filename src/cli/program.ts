import { Command, InvalidArgumentError, Option } from "commander";
import packageJson from "../../package.json";

export interface CliInvocation {
  json: boolean;
  command:
    | { kind: "create" }
    | { kind: "template"; language: string; ingest: "http" | "file" }
    | { kind: "reset"; sessionId: string }
    | {
        kind: "logs";
        sessionId: string;
        hypotheses: string[];
        offset: number;
        limit: number;
        snapshot?: string;
      }
    | {
        kind: "query";
        sessionId: string;
        program?: string;
        cursor?: string;
        slurp: boolean;
        limit: number;
        timeoutMs: number;
      }
    | { kind: "status"; sessionId: string }
    | { kind: "sessions"; all: boolean }
    | { kind: "clean"; sessionId: string }
    | { kind: "stop" };
}

export class CliParseError extends Error {
  readonly exitCode = 2;

  constructor(
    message: string,
    readonly output: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = "CliParseError";
  }
}

const collect = (value: string, previous: string[]): string[] => [...previous, value];

function parseIngest(value: string): "http" | "file" {
  if (value !== "http" && value !== "file") {
    throw new InvalidArgumentError('expected "http" or "file"');
  }
  return value;
}

function parseNonNegativeInteger(value: string): number {
  if (!/^\d+$/.test(value)) {
    throw new InvalidArgumentError("expected a non-negative integer");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new InvalidArgumentError("expected a safe integer");
  }
  return parsed;
}

function parsePositiveInteger(value: string): number {
  const parsed = parseNonNegativeInteger(value);
  if (parsed < 1) {
    throw new InvalidArgumentError("expected a positive integer");
  }
  return parsed;
}

function single<T>(parser: (value: string) => T): (value: string) => T {
  let seen = false;
  return (value: string): T => {
    if (seen) {
      throw new InvalidArgumentError("option may not be repeated");
    }
    seen = true;
    return parser(value);
  };
}

function stringValue(value: string): string {
  return value;
}

function requiredString(flags: string, description: string): Option {
  return new Option(flags, description).makeOptionMandatory().argParser(single(stringValue));
}

function captureBooleanRepetition(command: Command, optionName: string): void {
  let seen = false;
  command.on(`option:${optionName}`, () => {
    if (seen) {
      throw new InvalidArgumentError("option may not be repeated");
    }
    seen = true;
  });
}

export async function parseCli(argv: string[]): Promise<CliInvocation | { helpText: string }> {
  let stdout = "";
  let stderr = "";
  let invocation: CliInvocation | undefined;
  const program = new Command();

  program
    .name("debug-mode")
    .description("Collect and query structured runtime evidence")
    .version(packageJson.version)
    .helpCommand(false)
    .option("--json", "emit machine-readable JSON")
    .showHelpAfterError()
    .exitOverride()
    .configureOutput({
      writeOut: (text) => {
        stdout += text;
      },
      writeErr: (text) => {
        stderr += text;
      },
    })
    .action(() => {
      throw new CliParseError("A command is required.", "");
    });
  captureBooleanRepetition(program, "json");

  program
    .command("create")
    .description("Create a new debugging session")
    .action(() => {
      invocation = { command: { kind: "create" }, json: program.opts().json === true };
    });

  program
    .command("template")
    .description("Render a session-independent instrumentation template")
    .addOption(requiredString("--language <language>", "template language"))
    .addOption(
      new Option("--ingest <transport>", "ingestion transport")
        .makeOptionMandatory()
        .argParser(single(parseIngest)),
    )
    .action((options: { language: string; ingest: "http" | "file" }) => {
      invocation = {
        command: { ingest: options.ingest, kind: "template", language: options.language },
        json: program.opts().json === true,
      };
    });

  program
    .command("reset")
    .description("Reset evidence while preserving a session")
    .addOption(requiredString("--session <id>", "session identifier"))
    .action((options: { session: string }) => {
      invocation = {
        command: { kind: "reset", sessionId: options.session },
        json: program.opts().json === true,
      };
    });

  program
    .command("logs")
    .description("Read bounded structured session evidence")
    .addOption(requiredString("--session <id>", "session identifier"))
    .addOption(
      new Option("--hypothesis <id>", "filter by an observed hypothesis ID")
        .argParser(collect)
        .default([]),
    )
    .addOption(
      new Option("--offset <count>", "zero-based record offset")
        .argParser(single(parseNonNegativeInteger))
        .default(0),
    )
    .addOption(
      new Option("--limit <count>", "maximum records to return")
        .argParser(single(parsePositiveInteger))
        .default(100),
    )
    .addOption(
      new Option("--snapshot <cursor>", "continue a stable log snapshot").argParser(
        single(stringValue),
      ),
    )
    .action(
      (options: {
        session: string;
        hypothesis: string[];
        offset: number;
        limit: number;
        snapshot?: string;
      }) => {
        invocation = {
          command: {
            hypotheses: options.hypothesis,
            kind: "logs",
            limit: options.limit,
            offset: options.offset,
            sessionId: options.session,
            ...(options.snapshot === undefined ? {} : { snapshot: options.snapshot }),
          },
          json: program.opts().json === true,
        };
      },
    );

  const query = program
    .command("query")
    .description("Run an embedded jaq program against session evidence")
    .argument("[program]", "jaq program")
    .addOption(requiredString("--session <id>", "session identifier"))
    .addOption(
      new Option("--cursor <cursor>", "continue a paginated query").argParser(single(stringValue)),
    )
    .option("--slurp", "collect records before running the query")
    .addOption(
      new Option("--limit <count>", "maximum values to return")
        .argParser(single(parsePositiveInteger))
        .default(100),
    )
    .addOption(
      new Option("--timeout-ms <milliseconds>", "query timeout in milliseconds")
        .argParser(single(parsePositiveInteger))
        .default(2_000),
    )
    .action(
      (
        requestedProgram: string | undefined,
        options: {
          session: string;
          cursor?: string;
          slurp?: boolean;
          limit: number;
          timeoutMs: number;
        },
      ) => {
        invocation = {
          command: {
            ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
            kind: "query",
            limit: options.limit,
            ...(requestedProgram === undefined ? {} : { program: requestedProgram }),
            sessionId: options.session,
            slurp: options.slurp === true,
            timeoutMs: options.timeoutMs,
          },
          json: program.opts().json === true,
        };
      },
    );
  captureBooleanRepetition(query, "slurp");

  program
    .command("status")
    .description("Inspect session evidence health and diagnostics")
    .addOption(requiredString("--session <id>", "session identifier"))
    .action((options: { session: string }) => {
      invocation = {
        command: { kind: "status", sessionId: options.session },
        json: program.opts().json === true,
      };
    });

  const sessions = program
    .command("sessions")
    .description("List debugging sessions")
    .option("--all", "include historical sessions")
    .action((options: { all?: boolean }) => {
      invocation = {
        command: { all: options.all === true, kind: "sessions" },
        json: program.opts().json === true,
      };
    });
  captureBooleanRepetition(sessions, "all");

  program
    .command("clean")
    .description("Permanently remove a debugging session")
    .addOption(requiredString("--session <id>", "session identifier"))
    .action((options: { session: string }) => {
      invocation = {
        command: { kind: "clean", sessionId: options.session },
        json: program.opts().json === true,
      };
    });

  program
    .command("stop")
    .description("Stop the hidden background service")
    .action(() => {
      invocation = { command: { kind: "stop" }, json: program.opts().json === true };
    });

  try {
    await program.parseAsync(argv, { from: "user" });
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? String(error.code)
        : undefined;
    if (code === "commander.helpDisplayed" || code === "commander.version") {
      return { helpText: stdout + stderr };
    }
    if (error instanceof CliParseError) {
      throw new CliParseError(error.message, stderr || error.output, error.code);
    }
    const message = error instanceof Error ? error.message : "Invalid command-line arguments.";
    throw new CliParseError(message, stderr, code);
  }

  if (!invocation) {
    throw new CliParseError("A command is required.", stderr);
  }
  return invocation;
}
