import { describe, expect, test } from "bun:test";
import { renderProbe } from "../../src/probes/render";

const context = {
  ingestPath: "/tmp/incoming.ndjson",
  ingestUrl: "http://127.0.0.1:4321/v1/ingest/capability",
  runId: "baseline",
  sessionId: "session-1",
};

describe("probe renderers", () => {
  test("renders JavaScript without TypeScript syntax", () => {
    const probe = renderProbe("javascript", context);

    expect(probe.language).toBe("javascript");
    expect(probe.transport).toBe("http");
    expect(probe.helperTemplate).toContain("// #region agent log");
    expect(probe.helperTemplate).toContain("fetch(");
    expect(probe.helperTemplate).not.toContain("event:");
    expect(probe.callTemplate).toContain("__DATA_EXPRESSION__");
  });

  test("renders a bounded Python direct-append helper", () => {
    const probe = renderProbe("python", context);

    expect(probe.language).toBe("python");
    expect(probe.transport).toBe("direct-append");
    expect(probe.helperTemplate).toContain("# region agent log");
    expect(probe.helperTemplate).toContain(JSON.stringify(context.ingestPath));
    expect(probe.helperTemplate).toContain("16_384");
    expect(probe.helperTemplate).toContain("os.write");
    expect(probe.callTemplate).toContain("__DATA_EXPRESSION__");
  });

  test("normalizes supported language aliases and rejects unsupported languages", () => {
    expect(renderProbe("js", context).language).toBe("javascript");
    expect(renderProbe("ts", context).language).toBe("typescript");
    expect(renderProbe("py", context).language).toBe("python");
    expect(() => renderProbe("go", context)).toThrow("Unsupported probe language: go");
  });
});
