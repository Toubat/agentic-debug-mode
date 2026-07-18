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
    byteOffset: number,
    outputOrdinal: number,
    limit: number,
    timeoutMs: number,
  ): string;
  runJaqSlurpPage(
    program: string,
    path: string,
    hypothesesJson: string,
    watermark: number,
    spoolPath: string,
    spoolByteOffset: number,
    limit: number,
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
  nextByteOffset?: number;
  nextOutputOrdinal?: number;
  producedValues: number;
  returnedRecords: number;
}

interface NativeQueryFailure {
  error: {
    code: "EVIDENCE_MALFORMED" | "QUERY_SPOOL_UNAVAILABLE" | "QUERY_TIMEOUT";
    message?: string;
  };
  ok: false;
}

export class EvidenceMalformedError extends Error {
  readonly code = "EVIDENCE_MALFORMED";

  constructor(message: string) {
    super(message);
    this.name = "EvidenceMalformedError";
  }
}

export class QueryTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Query exceeded the ${timeoutMs}ms execution timeout`);
    this.name = "QueryTimeoutError";
  }
}

export class QuerySpoolUnavailableError extends Error {
  readonly code = "QUERY_RESOURCE_EXHAUSTED";

  constructor(message: string) {
    super(message);
    this.name = "QuerySpoolUnavailableError";
  }
}

const addon = require("../../native/query/addon.node") as QueryAddon;

function isNativeQueryFailure(value: unknown): value is NativeQueryFailure {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const response = value as Partial<NativeQueryFailure>;
  return (
    response.ok === false &&
    (response.error?.code === "QUERY_TIMEOUT" ||
      response.error?.code === "EVIDENCE_MALFORMED" ||
      response.error?.code === "QUERY_SPOOL_UNAVAILABLE")
  );
}

function parsePage(responseJson: string, timeoutMs: number): PagedFileQueryResult {
  const response: unknown = JSON.parse(responseJson);
  if (isNativeQueryFailure(response)) {
    switch (response.error.code) {
      case "EVIDENCE_MALFORMED":
        throw new EvidenceMalformedError(
          response.error.message ?? "Canonical evidence is malformed.",
        );
      case "QUERY_SPOOL_UNAVAILABLE":
        throw new QuerySpoolUnavailableError(
          response.error.message ?? "The private query spool is unavailable.",
        );
      case "QUERY_TIMEOUT":
        throw new QueryTimeoutError(timeoutMs);
      default: {
        const exhaustive: never = response.error.code;
        throw new Error(`Unhandled native query failure: ${exhaustive}`);
      }
    }
  }
  const page = response as Omit<PagedFileQueryResult, "hasNext"> & {
    nextByteOffset: number | null;
    nextOutputOrdinal: number | null;
  };
  const { nextByteOffset, nextOutputOrdinal, ...result } = page;
  return {
    ...result,
    hasNext: nextByteOffset !== null,
    ...(nextByteOffset === null ? {} : { nextByteOffset }),
    ...(nextOutputOrdinal === null ? {} : { nextOutputOrdinal }),
  };
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
  byteOffset: number,
  outputOrdinal: number,
  limit: number,
  timeoutMs: number,
): PagedFileQueryResult {
  return parsePage(
    addon.runJaqFilePage(
      program,
      path,
      JSON.stringify(hypotheses),
      watermark,
      byteOffset,
      outputOrdinal,
      limit,
      timeoutMs,
    ),
    timeoutMs,
  );
}

export function runJaqSlurpPage(
  program: string,
  path: string,
  hypotheses: string[],
  watermark: number,
  spoolPath: string,
  spoolByteOffset: number,
  limit: number,
  timeoutMs: number,
): PagedFileQueryResult {
  return parsePage(
    addon.runJaqSlurpPage(
      program,
      path,
      JSON.stringify(hypotheses),
      watermark,
      spoolPath,
      spoolByteOffset,
      limit,
      timeoutMs,
    ),
    timeoutMs,
  );
}
