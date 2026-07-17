import type { ParsedOption } from "../cli/parse-args";

export function optionString(
  options: Record<string, ParsedOption>,
  name: string,
): string | undefined {
  const value = options[name];
  return typeof value === "string" ? value : undefined;
}

export function optionStrings(options: Record<string, ParsedOption>, name: string): string[] {
  const value = options[name];
  if (Array.isArray(value)) {
    return value;
  }
  return typeof value === "string" ? [value] : [];
}

export function optionInteger(
  options: Record<string, ParsedOption>,
  name: string,
  fallback: number,
): number | undefined {
  const value = optionString(options, name);
  if (value === undefined) {
    return fallback;
  }
  if (!/^\d+$/.test(value)) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}
