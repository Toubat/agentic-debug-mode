import { describe, expect, test } from "bun:test";
import { parseCli } from "../../src/cli/program";
import { templateCommand } from "../../src/commands/template";
import {
  type IngestMethod,
  renderTemplate,
  TEMPLATE_EVENT_SCHEMA,
  type TemplateLanguage,
  UnsupportedTemplateError,
} from "../../src/probes/render";

const supported = [
  ["javascript", "http"],
  ["typescript", "http"],
  ["python", "file"],
  ["go", "file"],
  ["ruby", "file"],
  ["php", "file"],
  ["powershell", "file"],
  ["csharp", "file"],
  ["swift", "file"],
  ["rust", "file"],
  ["cpp", "file"],
  ["c", "file"],
  ["java", "file"],
  ["kotlin", "file"],
] as const satisfies readonly (readonly [TemplateLanguage, IngestMethod])[];

const callPlaceholders = [
  "__HYPOTHESIS_ID__",
  "__LOCATION__",
  "__MESSAGE__",
  "__DATA_EXPRESSION__",
] as const;

describe("session-independent template renderers", () => {
  for (const [language, ingest] of supported) {
    test(`${language} + ${ingest} returns exact source sections and placeholders`, () => {
      const template = renderTemplate(language, ingest);
      const target = ingest === "http" ? "__INGEST_URL__" : "__APPEND_PATH__";
      const otherTarget = ingest === "http" ? "__APPEND_PATH__" : "__INGEST_URL__";

      expect(template).toMatchObject({ ingest, language });
      expect(template.dataEncoding).toBe("native-json-value");
      expect(template.placement.call).toBe("statement");
      expect(template.placement.helper).toBe(
        language === "c" || language === "cpp" ? "file-start" : "top-level",
      );
      expect(template.helperTemplate).toContain(target);
      expect(template.helperTemplate).not.toContain(otherTarget);
      expect(template.callTemplate).not.toContain(target);
      expect(template.callTemplate).not.toContain(otherTarget);
      for (const placeholder of callPlaceholders) {
        expect(template.helperTemplate).not.toContain(placeholder);
        expect(template.callTemplate).toContain(placeholder);
      }
      expect(Object.keys(template.placeholders).sort()).toEqual(
        [target, ...callPlaceholders].sort(),
      );
      expect(`${template.helperTemplate}\n${template.callTemplate}`).not.toMatch(
        /sessionId|runId|schemaVersion|capability/i,
      );
      expect(template.helperTemplate).toContain("agent log");
      expect(template.callTemplate).toContain("agent log");
      expect(template.helperTemplate).toMatch(/65_?536|65536|64 \* 1024/);
      expect(template.helperTemplate.toLowerCase()).toMatch(/active|depth/);
    });
  }

  test("HTTP helpers clean up every fulfilled response body", () => {
    for (const language of ["javascript", "typescript"]) {
      const helper = renderTemplate(language, "http").helperTemplate;
      expect(helper).toContain(".body");
      expect(helper).toContain(".cancel()");
      expect(helper).toMatch(/\.then\(/);
      expect(helper).toMatch(/\.catch\(/);
    }
  });

  test("Swift uses one POSIX append write without seek APIs", () => {
    const helper = renderTemplate("swift", "file").helperTemplate;
    expect(helper).toContain("import Darwin");
    expect(helper).toContain("import Glibc");
    expect(helper).toContain("O_APPEND");
    expect(helper).toContain("O_CREAT");
    expect(helper).toContain("0o600");
    expect(helper).toContain("write(");
    expect(helper).not.toMatch(/seek|FileHandle/);
  });

  test("Python redacts tuples as recursive JSON arrays", () => {
    const helper = renderTemplate("python", "file").helperTemplate;
    expect(helper).toContain("(list, tuple)");
  });

  test("C# and PowerShell inspect custom value types instead of treating them as atomic", () => {
    const csharp = renderTemplate("csharp", "file").helperTemplate;
    expect(csharp).not.toContain("value.GetType().IsValueType");
    expect(csharp).toContain("IsPrimitive");
    expect(csharp).toContain("IsEnum");
    expect(csharp).toContain("GetFields");

    const powershell = renderTemplate("powershell", "file").helperTemplate;
    expect(powershell).not.toContain("$Value -is [ValueType]");
    expect(powershell).toContain("IsEnum");
    expect(powershell).toContain(".GetFields(");
  });

  test("normalizes documented aliases and casing", () => {
    expect(renderTemplate("JS", "HTTP").language).toBe("javascript");
    expect(renderTemplate("ts", "http").language).toBe("typescript");
    expect(renderTemplate("Py", "FILE").language).toBe("python");
    expect(renderTemplate("GoLang", "FILE").language).toBe("go");
    expect(renderTemplate("RB", "file").language).toBe("ruby");
    expect(renderTemplate("PHP", "FILE").language).toBe("php");
    expect(renderTemplate("PowerShell", "file").language).toBe("powershell");
    expect(renderTemplate("pwsh", "file").language).toBe("powershell");
    expect(renderTemplate("CSharp", "FILE").language).toBe("csharp");
    expect(renderTemplate("C#", "file").language).toBe("csharp");
    expect(renderTemplate("cs", "file").language).toBe("csharp");
    expect(renderTemplate("SWIFT", "FILE").language).toBe("swift");
    expect(renderTemplate("Rust", "FILE").language).toBe("rust");
    expect(renderTemplate("rs", "file").language).toBe("rust");
    expect(renderTemplate("CPP", "FILE").language).toBe("cpp");
    expect(renderTemplate("C++", "file").language).toBe("cpp");
    expect(renderTemplate("cxx", "file").language).toBe("cpp");
    expect(renderTemplate("C", "FILE").language).toBe("c");
    expect(renderTemplate("c", "file").language).toBe("c");
    expect(renderTemplate("Java", "FILE").language).toBe("java");
    expect(renderTemplate("java", "file").language).toBe("java");
    expect(renderTemplate("Kotlin", "FILE").language).toBe("kotlin");
    expect(renderTemplate("kt", "file").language).toBe("kotlin");
  });

  test("rejects every unadvertised language and ingest pair with a typed error", () => {
    for (const [language, ingest] of [
      ["javascript", "file"],
      ["typescript", "file"],
      ["python", "http"],
      ["go", "http"],
      ["ruby", "http"],
      ["php", "http"],
      ["powershell", "http"],
      ["csharp", "http"],
      ["swift", "http"],
      ["rust", "http"],
      ["cpp", "http"],
      ["c", "http"],
      ["java", "http"],
      ["kotlin", "http"],
      ["javascript", "socket"],
    ] as const) {
      try {
        renderTemplate(language, ingest);
        throw new Error(`Expected ${language} + ${ingest} to be rejected`);
      } catch (error) {
        expect(error).toBeInstanceOf(UnsupportedTemplateError);
        expect(error).toMatchObject({ code: "UNSUPPORTED_TEMPLATE" });
      }
    }
  });

  test("publishes the exact five-field event schema and timestamp units", () => {
    expect(TEMPLATE_EVENT_SCHEMA).toEqual({
      data: "bounded JSON value",
      hypothesisId: "string",
      location: "string",
      message: "string",
      timestamp: "Unix epoch milliseconds",
    });
  });

  test("template command returns source, placeholders, and schema without service access", () => {
    const output = templateCommand("javascript", "http");
    expect(output).toMatchObject({
      command: "template",
      data: {
        eventSchema: TEMPLATE_EVENT_SCHEMA,
        helperTemplate: expect.any(String),
        callTemplate: expect.any(String),
        placeholders: expect.any(Object),
      },
      ok: true,
      scope: {},
    });
  });

  test("template command reports unsupported pairs as UNSUPPORTED_TEMPLATE", () => {
    expect(templateCommand("python", "http")).toEqual({
      error: {
        code: "UNSUPPORTED_TEMPLATE",
        message: 'Unsupported template: language "python" with ingest "http".',
      },
      ok: false,
      schemaVersion: 1,
    });
  });

  test("template CLI never accepts a session option", async () => {
    await expect(
      parseCli(["template", "--language", "javascript", "--ingest", "http", "--session", "unused"]),
    ).rejects.toMatchObject({ exitCode: 2 });
  });
});
