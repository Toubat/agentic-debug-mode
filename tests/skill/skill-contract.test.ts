import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const skillDir = join(import.meta.dir, "..", "..", "skills", "agentic-debug-mode");
const skill = await readFile(join(skillDir, "SKILL.md"), "utf8").catch(() => "");
const reference = await readFile(join(skillDir, "REFERENCE.md"), "utf8").catch(() => "");
const examples = await readFile(join(skillDir, "EXAMPLES.md"), "utf8").catch(() => "");

describe("agentic-debug-mode skill", () => {
  test("is discoverable, portable, and concise", () => {
    expect(skill).toContain("name: agentic-debug-mode");
    expect(skill).toMatch(/description: Use when .+runtime evidence/);
    expect(skill).not.toContain("disable-model-invocation: true");
    expect(skill).not.toContain("Cursor");
    expect(skill.split("\n").length).toBeLessThan(500);
  });

  test("uses the session-only pretty workflow", () => {
    expect(skill).toContain("debug-mode create");
    expect(skill).toContain("debug-mode template --language");
    expect(skill).toContain("debug-mode reset --session");
    expect(skill).toContain("debug-mode logs --session");
    expect(skill).toContain("debug-mode query --session");
    expect(skill).toContain("debug-mode status --session");
    expect(skill).toContain("debug-mode sessions");
    expect(skill).toContain("debug-mode clean --session");
    expect(skill).toContain("debug-mode stop");
  });

  test("hides service internals and removed interfaces", () => {
    expect(skill).not.toContain("--json");
    expect(skill).not.toContain("--workspace");
    expect(skill).not.toContain("--run-id");
    expect(skill).not.toContain("data.instrumentation");
    expect(skill).not.toContain("daemon");
    expect(skill).not.toContain("capability");
    expect(skill).not.toContain("debug-mode start");
    expect(skill).not.toContain("debug-mode probe");
    expect(skill).not.toContain("debug-mode clear");
    expect(skill).not.toContain("run begin");
    expect(skill).not.toContain("UNDECLARED_HYPOTHESIS");
    expect(skill).not.toMatch(/\/v1\/|control\.token|incoming\.ndjson|events\.ndjson/);
  });

  test("resolves the public CLI without unsafe installation", () => {
    expect(skill).toContain("debug-mode --version");
    expect(skill).toContain("npm install --global agentic-debug-mode@latest");
    expect(skill).toContain("npx --yes agentic-debug-mode@latest");
    expect(skill).toContain("Homebrew only when the project documents its official tap coordinate");
    expect(skill).toContain("Never use an unverified `curl | sh`");
  });

  test("enforces evidence-first diagnosis and safe evidence access", () => {
    expect(skill).toContain("Do not implement a bug fix before collecting runtime evidence");
    expect(skill).toContain(
      "Use only `debug-mode logs`, `debug-mode query`, and `debug-mode status`",
    );
    expect(skill).toContain("Never use native file-reading tools");
    expect(skill).toContain("CONFIRMED");
    expect(skill).toContain("REJECTED");
    expect(skill).toContain("INCONCLUSIVE");
  });

  test("never delegates reproducible agent-accessible work to the user", () => {
    expect(skill).toContain("Do not ask the user to perform an action you can execute");
    expect(skill).toContain("Run available CLI commands, tests, and HTTP requests yourself");
    expect(skill).toContain("Ask the user only for inaccessible");
  });

  test("documents the exact probe event schema and timestamp units", () => {
    expect(skill).toContain("hypothesisId");
    expect(skill).toContain("location");
    expect(skill).toContain("message");
    expect(skill).toContain("data");
    expect(skill).toContain("timestamp");
    expect(skill).toContain("Unix epoch milliseconds");
    expect(skill).toContain("#region agent log");
    expect(skill).toContain("#endregion");
  });

  test("distinguishes reset, clean, and stop, and retains observations until verified", () => {
    expect(skill).toContain("baseline");
    expect(skill).toContain("post-fix");
    expect(skill).toMatch(/reset[\s\S]*reuses/i);
    expect(skill).toMatch(/clean[\s\S]*permanently/i);
    expect(skill).toMatch(/stop[\s\S]*without deleting/i);
  });

  test("links one-level-deep supporting files that exist", () => {
    expect(skill).toContain("REFERENCE.md");
    expect(skill).toContain("EXAMPLES.md");
    expect(reference.length).toBeGreaterThan(0);
    expect(examples.length).toBeGreaterThan(0);
  });

  test("reserves JSON output for external integrations in the reference only", () => {
    expect(reference).toContain("--json");
    expect(examples).not.toContain("--workspace");
    expect(examples).not.toContain("--run-id");
    expect(examples).not.toContain("daemon");
  });
});
