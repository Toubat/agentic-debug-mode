import { type JavaScriptProbeTemplates, renderJavaScriptProbe } from "./javascript";
import { type PythonProbeTemplates, renderPythonProbe } from "./python";
import { renderTypeScriptProbe, type TypeScriptProbeTemplates } from "./typescript";

export interface ProbeContext {
  ingestPath: string;
  ingestUrl: string;
  runId: string;
  sessionId: string;
}

export type ProbeTemplates =
  | JavaScriptProbeTemplates
  | PythonProbeTemplates
  | TypeScriptProbeTemplates;

export type ProbeLanguage = ProbeTemplates["language"];

export function normalizeProbeLanguage(language: string): ProbeLanguage {
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
    default:
      throw new Error(`Unsupported probe language: ${language}`);
  }
}

export function renderProbe(language: string, context: ProbeContext): ProbeTemplates {
  const normalized = normalizeProbeLanguage(language);
  switch (normalized) {
    case "javascript":
      return renderJavaScriptProbe(context);
    case "typescript":
      return renderTypeScriptProbe(context);
    case "python":
      return renderPythonProbe(context);
    default: {
      const exhaustive: never = normalized;
      throw new Error(`Unsupported probe language: ${exhaustive}`);
    }
  }
}
