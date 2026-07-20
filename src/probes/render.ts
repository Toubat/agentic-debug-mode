import { renderCTemplate } from "./c";
import { renderCppTemplate } from "./cpp";
import { renderCSharpTemplate } from "./csharp";
import { renderGoTemplate } from "./go";
import { renderJavaTemplate } from "./java";
import { renderJavaScriptTemplate } from "./javascript";
import { renderKotlinTemplate } from "./kotlin";
import { renderPhpTemplate } from "./php";
import { renderPowerShellTemplate } from "./powershell";
import { renderPythonTemplate } from "./python";
import { renderRubyTemplate } from "./ruby";
import { renderRustTemplate } from "./rust";
import { renderSwiftTemplate } from "./swift";
import { renderTypeScriptTemplate } from "./typescript";

export type TemplateLanguage =
  | "javascript"
  | "typescript"
  | "python"
  | "go"
  | "ruby"
  | "php"
  | "powershell"
  | "csharp"
  | "swift"
  | "rust"
  | "cpp"
  | "c"
  | "java"
  | "kotlin";

export type IngestMethod = "http" | "file";

export type ProbeDataEncoding = "native-json-value" | "serialized-json";

export interface ProbeTemplates {
  language: TemplateLanguage;
  ingest: IngestMethod;
  dataEncoding: ProbeDataEncoding;
  helperTemplate: string;
  callTemplate: string;
  placeholders: Record<string, string>;
  placement: {
    helper: "file-start" | "top-level";
    call: "statement";
  };
}

export const TEMPLATE_EVENT_SCHEMA = {
  data: "bounded JSON value",
  hypothesisId: "string",
  location: "string",
  message: "string",
  timestamp: "Unix epoch milliseconds",
} as const;

export class UnsupportedTemplateError extends Error {
  readonly code = "UNSUPPORTED_TEMPLATE";

  constructor(
    readonly language: string,
    readonly ingest: string,
  ) {
    super(`Unsupported template: language "${language}" with ingest "${ingest}".`);
    this.name = "UnsupportedTemplateError";
  }
}

function normalizeLanguage(language: string): TemplateLanguage | undefined {
  switch (language.toLowerCase()) {
    case "javascript":
    case "js":
      return "javascript";
    case "typescript":
    case "ts":
      return "typescript";
    case "python":
    case "py":
      return "python";
    case "go":
    case "golang":
      return "go";
    case "ruby":
    case "rb":
      return "ruby";
    case "php":
      return "php";
    case "powershell":
    case "pwsh":
      return "powershell";
    case "csharp":
    case "c#":
    case "cs":
      return "csharp";
    case "swift":
      return "swift";
    case "rust":
    case "rs":
      return "rust";
    case "cpp":
    case "c++":
    case "cxx":
      return "cpp";
    case "c":
      return "c";
    case "java":
      return "java";
    case "kotlin":
    case "kt":
      return "kotlin";
    default:
      return undefined;
  }
}

export function renderTemplate(language: string, ingest: string): ProbeTemplates {
  const normalizedLanguage = normalizeLanguage(language);
  const normalizedIngest = ingest.toLowerCase();
  if (!normalizedLanguage || (normalizedIngest !== "http" && normalizedIngest !== "file")) {
    throw new UnsupportedTemplateError(language, ingest);
  }

  const requestedPair = `${normalizedLanguage}:${normalizedIngest}`;
  switch (requestedPair) {
    case "javascript:http":
      return renderJavaScriptTemplate();
    case "typescript:http":
      return renderTypeScriptTemplate();
    case "python:file":
      return renderPythonTemplate();
    case "go:file":
      return renderGoTemplate();
    case "ruby:file":
      return renderRubyTemplate();
    case "php:file":
      return renderPhpTemplate();
    case "powershell:file":
      return renderPowerShellTemplate();
    case "csharp:file":
      return renderCSharpTemplate();
    case "swift:file":
      return renderSwiftTemplate();
    case "rust:file":
      return renderRustTemplate();
    case "cpp:file":
      return renderCppTemplate();
    case "c:file":
      return renderCTemplate();
    case "java:file":
      return renderJavaTemplate();
    case "kotlin:file":
      return renderKotlinTemplate();
    default:
      throw new UnsupportedTemplateError(language, ingest);
  }
}
