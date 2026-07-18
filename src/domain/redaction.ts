import type { JsonValue } from "./event";

export const SENSITIVE_KEY_EXACT = [
  "authorization",
  "authorization_header",
  "cookie",
  "set_cookie",
  "password",
  "passwd",
  "pwd",
  "private_key",
  "secret",
  "token",
  "credential",
  "credentials",
] as const;

export const SENSITIVE_KEY_QUALIFIED = [
  "api_key",
  "api_token",
  "oauth_token",
  "o_auth_token",
  "private_key",
  "client_secret",
  "access_token",
  "refresh_token",
  "id_token",
  "auth_token",
  "bearer_token",
] as const;

const SENSITIVE_KEY_SET = new Set<string>(SENSITIVE_KEY_EXACT);
const SENSITIVE_QUALIFIED_SUFFIX = new RegExp(`(^|_)(${SENSITIVE_KEY_QUALIFIED.join("|")})$`);

export function normalizeSensitiveKey(key: string): string {
  return key
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .toLowerCase()
    .replace(/^_+|_+$/g, "");
}

export function isSensitiveKey(key: string): boolean {
  const normalized = normalizeSensitiveKey(key);
  return SENSITIVE_KEY_SET.has(normalized) || SENSITIVE_QUALIFIED_SUFFIX.test(normalized);
}

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
        if (isSensitiveKey(key)) {
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
