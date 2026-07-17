import { describe, expect, test } from "bun:test";
import { dispatch } from "../../src/cli/dispatch";
import { parseArgs } from "../../src/cli/parse-args";

describe("CLI dispatch", () => {
  test("--version returns the versioned command envelope", async () => {
    expect(await dispatch(parseArgs(["--version", "--json"]))).toEqual({
      command: "version",
      data: { version: "0.1.0" },
      hints: [],
      ok: true,
      partial: false,
      schemaVersion: 1,
      scope: {},
      statistics: {},
      warnings: [],
    });
  });
});
