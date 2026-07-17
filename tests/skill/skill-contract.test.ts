import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const skillPath = join(import.meta.dir, "..", "..", "skills", "agentic-debug-mode", "SKILL.md");
const skill = await readFile(skillPath, "utf8").catch(() => "");

describe("agentic-debug-mode skill", () => {
  test("is discoverable, portable, and concise", () => {
    expect(skill).toContain("name: agentic-debug-mode");
    expect(skill).toMatch(/description: .+runtime evidence/);
    expect(skill).not.toContain("disable-model-invocation: true");
    expect(skill).not.toContain("Cursor");
    expect(skill.split("\n").length).toBeLessThan(500);
  });

  test("resolves the public CLI without unsafe installation", () => {
    expect(skill).toContain("debug-mode --version");
    expect(skill).toContain("brew install agentic-debug-mode");
    expect(skill).toContain("npm install --global agentic-debug-mode");
    expect(skill).toContain("npx --yes agentic-debug-mode@latest");
    expect(skill).toContain("Never use an unverified `curl | sh`");
  });

  test("enforces evidence-first diagnosis and safe evidence access", () => {
    expect(skill).toContain("Do not implement a bug fix before collecting runtime evidence");
    expect(skill).toContain(
      "Use only `debug-mode logs`, `debug-mode query`, and `debug-mode status`",
    );
    expect(skill).toContain("Never use native file-reading tools");
    expect(skill).toContain("INCONCLUSIVE");
  });

  test("preserves malformed diagnostics, probe regions, and verification runs", () => {
    expect(skill).toContain("If `logs` or `query` reports malformed records");
    expect(skill).toContain("Preserve all opening and closing markers");
    expect(skill).toContain("Keep probes during the fix and verification");
    expect(skill).toContain("baseline");
    expect(skill).toContain("post-fix");
  });

  test("does not expose daemon internals or unimplemented commands", () => {
    expect(skill).not.toMatch(/\/v1\/|control\.token|daemon\.json|incoming\.ndjson|events\.ndjson/);
    expect(skill).not.toContain("debug-mode clean");
  });
});
