export type ParsedOption = boolean | string | string[];

export interface ParsedArgs {
  command: string[];
  options: Record<string, ParsedOption>;
  positionals: string[];
}

const BOOLEAN_OPTIONS = new Set(["follow", "force", "help", "json", "jsonl", "slurp", "version"]);

function addOption(
  options: Record<string, ParsedOption>,
  name: string,
  value: boolean | string,
): void {
  const current = options[name];
  if (current === undefined) {
    options[name] = value;
    return;
  }
  if (Array.isArray(current)) {
    current.push(String(value));
    return;
  }
  options[name] = [String(current), String(value)];
}

export function parseArgs(argv: string[]): ParsedArgs {
  const hasCommand = argv[0] !== undefined && !argv[0].startsWith("--");
  const command = hasCommand ? argv[0] : undefined;
  const tokens = hasCommand ? argv.slice(1) : argv;
  const parsed: ParsedArgs = {
    command: command ? [command] : [],
    options: {},
    positionals: [],
  };

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === undefined) {
      break;
    }
    if (!token.startsWith("--")) {
      parsed.positionals.push(token);
      continue;
    }

    const option = token.slice(2);
    const equalsIndex = option.indexOf("=");
    if (equalsIndex >= 0) {
      addOption(parsed.options, option.slice(0, equalsIndex), option.slice(equalsIndex + 1));
      continue;
    }

    if (BOOLEAN_OPTIONS.has(option)) {
      addOption(parsed.options, option, true);
      continue;
    }

    const next = tokens[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      addOption(parsed.options, option, next);
      index += 1;
      continue;
    }
    addOption(parsed.options, option, true);
  }

  return parsed;
}
