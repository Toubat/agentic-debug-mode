interface QueryAddon {
  runJaq(program: string, inputJson: string): string;
  runJaqBatch(program: string, inputsJson: string, slurp: boolean): string;
  runJaqFile(
    program: string,
    path: string,
    runId: string,
    hypothesesJson: string,
    watermark: number,
    slurp: boolean,
  ): string;
}

export interface FileQueryResult {
  results: unknown[];
  scannedRecords: number;
  totalRecords: number;
}

const addon = require("../../native/query/addon.node") as QueryAddon;

export function runJaq(program: string, input: unknown): unknown[] {
  return JSON.parse(addon.runJaq(program, JSON.stringify(input))) as unknown[];
}

export function runJaqBatch(program: string, inputs: unknown[], slurp: boolean): unknown[] {
  return JSON.parse(addon.runJaqBatch(program, JSON.stringify(inputs), slurp)) as unknown[];
}

export function runJaqFile(
  program: string,
  path: string,
  runId: string,
  hypotheses: string[],
  watermark: number,
  slurp: boolean,
): FileQueryResult {
  return JSON.parse(
    addon.runJaqFile(program, path, runId, JSON.stringify(hypotheses), watermark, slurp),
  ) as FileQueryResult;
}
