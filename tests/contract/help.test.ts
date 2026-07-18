import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseCli } from "../../src/cli/program";

// program.ts reports packageJson.version live, so the expected value must track
// the root package version rather than a hardcoded string that breaks on release bumps.
const rootVersion = (
  JSON.parse(await readFile(join(import.meta.dir, "..", "..", "package.json"), "utf8")) as {
    version: string;
  }
).version;

async function expectExitTwo(argv: string[]): Promise<void> {
  await expect(parseCli(argv)).rejects.toMatchObject({ exitCode: 2 });
}

async function runCli(
  argv: string[],
): Promise<{ exitCode: number; stderr: string; stdout: string }> {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "../../src/cli.ts"), ...argv], {
    stderr: "pipe",
    stdout: "pipe",
  });
  const [exitCode, stderr, stdout] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
    new Response(child.stdout).text(),
  ]);
  return { exitCode, stderr, stdout };
}

describe("Commander CLI help and errors", () => {
  test("explicitly disables Commander's automatic help command", async () => {
    const source = await Bun.file(join(import.meta.dir, "../../src/cli/program.ts")).text();

    expect(source).toContain(".helpCommand(false)");
  });

  test("--help lists exactly the redesigned public commands", async () => {
    const result = await parseCli(["--help"]);
    const help = "helpText" in result ? result.helpText : "";
    const commandLines = help.split("Commands:\n")[1] ?? "";
    const commands = commandLines
      .split("\n")
      .map((line) => /^ {2}([a-z][a-z-]*)(?:\s|\[)/.exec(line)?.[1])
      .filter((command): command is string => command !== undefined);

    expect(commands).toEqual([
      "create",
      "template",
      "reset",
      "logs",
      "query",
      "status",
      "sessions",
      "clean",
      "stop",
    ]);
  });

  test("command help is generated without creating an invocation", async () => {
    const result = await parseCli(["template", "--help"]);
    const help = "helpText" in result ? result.helpText : "";

    expect(help).toContain("Usage: debug-mode template");
    expect(help).toContain("--language <language>");
    expect(help).toContain("--ingest <transport>");
  });

  test("--version returns package version text", async () => {
    await expect(parseCli(["--version"])).resolves.toEqual({ helpText: `${rootVersion}\n` });
  });

  test("rejects unknown commands and missing required options", async () => {
    await expectExitTwo(["help"]);
    await expectExitTwo(["start"]);
    await expectExitTwo(["logs"]);
  });

  test("rejects removed and unknown options", async () => {
    await expectExitTwo(["logs", "--session", "s1", "--follow"]);
    await expectExitTwo(["create", "--workspace", "."]);
    await expectExitTwo(["query", "--session", "s1", "--hypothesis", "H1", "."]);
  });

  test("rejects repeated singleton options", async () => {
    await expectExitTwo(["logs", "--session", "s1", "--session", "s2"]);
    await expectExitTwo(["--json", "--json", "create"]);
    await expectExitTwo(["sessions", "--all", "--all"]);
    await expectExitTwo(["query", "--session", "s1", "--slurp", "--slurp", "."]);
    await expectExitTwo([
      "template",
      "--language",
      "python",
      "--language",
      "typescript",
      "--ingest",
      "file",
    ]);
  });

  test("accepts repeated hypotheses only for logs", async () => {
    await expect(
      parseCli(["logs", "--session", "s1", "--hypothesis", "H1", "--hypothesis", "H2"]),
    ).resolves.toMatchObject({
      command: { hypotheses: ["H1", "H2"], kind: "logs" },
    });
  });

  test("standalone help and version exit zero while parse failures exit two", async () => {
    for (const argv of [["--help"], ["template", "--help"], ["--version"]]) {
      const result = await runCli(argv);
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout.length).toBeGreaterThan(0);
    }

    for (const argv of [
      ["help"],
      ["unknown"],
      ["logs"],
      ["create", "--workspace", "."],
      ["logs", "--session", "s1", "--session", "s2"],
    ]) {
      const result = await runCli(argv);
      expect(result.exitCode).toBe(2);
      expect(result.stderr.length).toBeGreaterThan(0);
      expect(result.stdout).toBe("");
    }
  });
});
