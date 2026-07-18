import { describe, expect, test } from "bun:test";
import { DaemonVersionIncompatibleError } from "../../src/cli/daemon-manager";
import { exitCodeForError } from "../../src/cli/exit-codes";
import { commandError } from "../../src/commands/errors";

describe("semantic exit codes", () => {
  test("maps structured failures to stable process exit codes", () => {
    expect(exitCodeForError("INVALID_ARGUMENTS")).toBe(2);
    expect(exitCodeForError("VERSION_INCOMPATIBLE")).toBe(3);
    expect(exitCodeForError("DAEMON_UNAVAILABLE")).toBe(4);
    expect(exitCodeForError("SESSION_NOT_FOUND")).toBe(5);
    expect(exitCodeForError("EVIDENCE_MALFORMED")).toBe(6);
    expect(exitCodeForError("UNKNOWN_FAILURE")).toBe(1);
  });

  test("preserves daemon version incompatibility as exit code 3", () => {
    const output = commandError(
      new DaemonVersionIncompatibleError("active incompatible daemon"),
      "DAEMON_UNAVAILABLE",
      "unavailable",
    );

    expect(output.ok).toBe(false);
    if (output.ok) {
      throw new Error("Expected a command error");
    }
    expect(output.error.code).toBe("VERSION_INCOMPATIBLE");
    expect(exitCodeForError(output.error.code)).toBe(3);
  });
});
