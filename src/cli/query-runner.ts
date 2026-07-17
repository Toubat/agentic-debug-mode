import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import type { FileQueryResult } from "../native/query";

export interface QueryWorkerInput {
  hypotheses: string[];
  path: string;
  program: string;
  slurp: boolean;
  watermark: number;
}

function workerCommand(): string[] {
  const sourceCli = join(import.meta.dir, "..", "cli.ts");
  if (basename(process.execPath).startsWith("bun") && existsSync(sourceCli)) {
    return [process.execPath, sourceCli, "__query-native"];
  }
  return [process.execPath, "__query-native"];
}

export async function runQueryWithTimeout(
  input: QueryWorkerInput,
  timeoutMilliseconds: number,
): Promise<FileQueryResult> {
  const child = Bun.spawn(workerCommand(), {
    stderr: "pipe",
    stdin: "pipe",
    stdout: "pipe",
    windowsHide: true,
  });
  child.stdin.write(JSON.stringify(input));
  child.stdin.end();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, timeoutMilliseconds);
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  clearTimeout(timeout);
  if (timedOut) {
    throw new Error(`Query exceeded the ${timeoutMilliseconds}ms execution timeout`);
  }
  if (exitCode !== 0) {
    throw new Error(stderr.trim() || `Query worker exited with ${exitCode}`);
  }
  return JSON.parse(stdout) as FileQueryResult;
}
