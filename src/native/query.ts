interface QueryAddon {
  runJaq(program: string, inputJson: string): string;
  runJaqBatch(program: string, inputsJson: string, slurp: boolean): string;
  runJaqFile(
    program: string,
    path: string,
    hypothesesJson: string,
    watermark: number,
    slurp: boolean,
  ): string;
  runJaqFilePage(
    program: string,
    path: string,
    hypothesesJson: string,
    watermark: number,
    offset: number,
    limit: number,
    slurp: boolean,
    timeoutMs: number,
  ): string;
}

export interface FileQueryResult {
  hasNext?: boolean;
  producedValues?: number;
  results: unknown[];
  returnedRecords?: number;
  scannedRecords: number;
  totalRecords: number;
}

export interface PagedFileQueryResult extends FileQueryResult {
  hasNext: boolean;
  producedValues: number;
  returnedRecords: number;
}

interface NativeQueryTimeout {
  error: {
    code: "QUERY_TIMEOUT";
  };
  ok: false;
}

export class QueryTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Query exceeded the ${timeoutMs}ms execution timeout`);
    this.name = "QueryTimeoutError";
  }
}

const addon = require("../../native/query/addon.node") as QueryAddon;

function isNativeQueryTimeout(value: unknown): value is NativeQueryTimeout {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const response = value as Partial<NativeQueryTimeout>;
  return response.ok === false && response.error?.code === "QUERY_TIMEOUT";
}

export function runJaq(program: string, input: unknown): unknown[] {
  return JSON.parse(addon.runJaq(program, JSON.stringify(input))) as unknown[];
}

export function runJaqBatch(program: string, inputs: unknown[], slurp: boolean): unknown[] {
  return JSON.parse(addon.runJaqBatch(program, JSON.stringify(inputs), slurp)) as unknown[];
}

export function runJaqFile(
  program: string,
  path: string,
  hypotheses: string[],
  watermark: number,
  slurp: boolean,
): FileQueryResult {
  return JSON.parse(
    addon.runJaqFile(program, path, JSON.stringify(hypotheses), watermark, slurp),
  ) as FileQueryResult;
}

export function runJaqFilePage(
  program: string,
  path: string,
  hypotheses: string[],
  watermark: number,
  offset: number,
  limit: number,
  slurp: boolean,
  timeoutMs: number,
): PagedFileQueryResult {
  const response: unknown = JSON.parse(
    addon.runJaqFilePage(
      program,
      path,
      JSON.stringify(hypotheses),
      watermark,
      offset,
      limit,
      slurp,
      timeoutMs,
    ),
  );
  if (isNativeQueryTimeout(response)) {
    throw new QueryTimeoutError(timeoutMs);
  }
  return response as PagedFileQueryResult;
}
