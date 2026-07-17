import { describe, expect, test } from "bun:test";
import { parseArgs } from "../../src/cli/parse-args";

describe("CLI argument parsing", () => {
  test("preserves repeated hypotheses and a positional jaq program", () => {
    expect(
      parseArgs([
        "query",
        "--session",
        "session-1",
        "--run-id=baseline",
        "--hypothesis",
        "H1",
        "--hypothesis",
        "H2",
        "--json",
        'select(.message | test("timeout"))',
      ]),
    ).toEqual({
      command: ["query"],
      options: {
        hypothesis: ["H1", "H2"],
        json: true,
        "run-id": "baseline",
        session: "session-1",
      },
      positionals: ['select(.message | test("timeout"))'],
    });
  });

  test("parses global flags without treating them as a command", () => {
    expect(parseArgs(["--version", "--json"])).toEqual({
      command: [],
      options: { json: true, version: true },
      positionals: [],
    });
  });
});
