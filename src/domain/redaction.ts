import type { JsonValue } from "./event";

const SECRET_KEY = /^(authorization|cookie|password|private[-_]?key|secret|token)$/i;

export interface RedactionResult {
  redactedPaths: string[];
  value: JsonValue;
}

function redact(value: JsonValue, path: string, redactedPaths: string[]): JsonValue {
  if (Array.isArray(value)) {
    return value.map((item, index) => redact(item, `${path}[${index}]`, redactedPaths));
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => {
        const itemPath = path ? `${path}.${key}` : key;
        if (SECRET_KEY.test(key)) {
          redactedPaths.push(itemPath);
          return [key, "[REDACTED]"];
        }
        return [key, redact(item, itemPath, redactedPaths)];
      }),
    );
  }
  return value;
}

export function redactSecrets(value: JsonValue): RedactionResult {
  const redactedPaths: string[] = [];
  return { redactedPaths, value: redact(value, "", redactedPaths) };
}
