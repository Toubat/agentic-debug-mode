interface QueryAddon {
  runJaq(program: string, inputJson: string): string;
}

const addon = require("../../native/query/addon.node") as QueryAddon;

export function runJaq(program: string, input: unknown): unknown[] {
  return JSON.parse(addon.runJaq(program, JSON.stringify(input))) as unknown[];
}
