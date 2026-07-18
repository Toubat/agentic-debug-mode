import { describe, expect, test } from "bun:test";
import { parseCli } from "../../src/cli/program";

describe("CLI invocation parsing", () => {
  test("parses every public command with typed defaults", async () => {
    await expect(parseCli(["create"])).resolves.toEqual({
      command: { kind: "create" },
      json: false,
    });
    await expect(
      parseCli(["template", "--language", "python", "--ingest", "file"]),
    ).resolves.toEqual({
      command: { ingest: "file", kind: "template", language: "python" },
      json: false,
    });
    await expect(parseCli(["reset", "--session", "s1"])).resolves.toEqual({
      command: { kind: "reset", sessionId: "s1" },
      json: false,
    });
    await expect(parseCli(["logs", "--session", "s1"])).resolves.toEqual({
      command: {
        hypotheses: [],
        kind: "logs",
        limit: 100,
        offset: 0,
        sessionId: "s1",
      },
      json: false,
    });
    await expect(parseCli(["query", "--session", "s1", "."])).resolves.toEqual({
      command: {
        kind: "query",
        limit: 100,
        program: ".",
        sessionId: "s1",
        slurp: false,
        timeoutMs: 2_000,
      },
      json: false,
    });
    await expect(parseCli(["status", "--session", "s1"])).resolves.toEqual({
      command: { kind: "status", sessionId: "s1" },
      json: false,
    });
    await expect(parseCli(["sessions"])).resolves.toEqual({
      command: { all: false, kind: "sessions" },
      json: false,
    });
    await expect(parseCli(["clean", "--session", "s1"])).resolves.toEqual({
      command: { kind: "clean", sessionId: "s1" },
      json: false,
    });
    await expect(parseCli(["stop"])).resolves.toEqual({
      command: { kind: "stop" },
      json: false,
    });
  });

  test("parses pagination, cursor, transport, and global JSON options", async () => {
    await expect(
      parseCli([
        "--json",
        "logs",
        "--session",
        "s1",
        "--offset",
        "5",
        "--limit",
        "25",
        "--snapshot",
        "snapshot-token",
      ]),
    ).resolves.toEqual({
      command: {
        hypotheses: [],
        kind: "logs",
        limit: 25,
        offset: 5,
        sessionId: "s1",
        snapshot: "snapshot-token",
      },
      json: true,
    });
    await expect(
      parseCli([
        "--json",
        "query",
        "--session",
        "s1",
        "--cursor",
        "cursor-token",
        "--slurp",
        "--limit",
        "10",
        "--timeout-ms",
        "500",
      ]),
    ).resolves.toEqual({
      command: {
        cursor: "cursor-token",
        kind: "query",
        limit: 10,
        sessionId: "s1",
        slurp: true,
        timeoutMs: 500,
      },
      json: true,
    });
  });

  test("rejects invalid enumerated and integer option values", async () => {
    await expect(
      parseCli(["template", "--language", "python", "--ingest", "socket"]),
    ).rejects.toMatchObject({ exitCode: 2 });
    await expect(parseCli(["logs", "--session", "s1", "--offset", "-1"])).rejects.toMatchObject({
      exitCode: 2,
    });
    await expect(
      parseCli(["query", "--session", "s1", ".", "--timeout-ms", "0"]),
    ).rejects.toMatchObject({ exitCode: 2 });
  });
});
