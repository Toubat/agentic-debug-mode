import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderTemplate } from "../../../src/probes/render";

const pythonExecutable = Bun.which("python3") ?? Bun.which("python");

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
}, 30_000);

describe("Python probe failure isolation", () => {
  test.skipIf(pythonExecutable === null)(
    "never changes application startup when the evidence path cannot open",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "agent-debug-mode-python-"));
      temporaryDirectories.push(directory);
      const probe = renderTemplate("python", "file");
      const source = [
        probe.helperTemplate.replace(
          "__APPEND_PATH__",
          // Escape backslashes so a Windows path (e.g. C:\Users\...) is not
          // interpreted as an escape sequence inside the Python string literal.
          join(directory, "missing", "incoming.ndjson").replaceAll("\\", "\\\\"),
        ),
        probe.callTemplate
          .replace("__HYPOTHESIS_ID__", "H1")
          .replace("__LOCATION__", "fixture.py:1")
          .replace("__MESSAGE__", "Failure isolated")
          .replace("__DATA_EXPRESSION__", '{"value": 1}'),
        'print("application-started")',
      ].join("\n\n");
      const path = join(directory, "probe.py");
      await writeFile(path, source);

      const child = Bun.spawn([pythonExecutable ?? "", path], {
        stderr: "pipe",
        stdout: "pipe",
      });
      const [exitCode, stdout] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
      ]);
      expect(exitCode).toBe(0);
      expect(stdout).toContain("application-started");
    },
  );
});
