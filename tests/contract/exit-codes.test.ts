import { describe, expect, test } from "bun:test";
import { exitCodeForError } from "../../src/cli/exit-codes";

describe("semantic exit codes", () => {
  test("maps structured failures to stable process exit codes", () => {
    expect(exitCodeForError("INVALID_ARGUMENTS")).toBe(2);
    expect(exitCodeForError("VERSION_INCOMPATIBLE")).toBe(3);
    expect(exitCodeForError("DAEMON_UNAVAILABLE")).toBe(4);
    expect(exitCodeForError("SESSION_NOT_FOUND")).toBe(5);
    expect(exitCodeForError("EVIDENCE_MALFORMED")).toBe(6);
    expect(exitCodeForError("UNKNOWN_FAILURE")).toBe(1);
  });
});
