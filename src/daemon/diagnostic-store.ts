import { appendFile, readFile } from "node:fs/promises";
import type { EvidenceDiagnostic } from "../domain/diagnostic";
import { writeTextAtomic } from "../platform/atomic-file";
import type { Persistence } from "./persistence";

export class DiagnosticStore {
  private readonly operations = new Map<string, Promise<void>>();

  constructor(private readonly persistence: Persistence) {}

  private async enqueue<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.operations.get(sessionId) ?? Promise.resolve();
    const result = previous.then(operation);
    const settled = result.then(
      () => undefined,
      () => undefined,
    );
    this.operations.set(sessionId, settled);
    try {
      return await result;
    } finally {
      if (this.operations.get(sessionId) === settled) {
        this.operations.delete(sessionId);
      }
    }
  }

  private async readFile(sessionId: string): Promise<EvidenceDiagnostic[]> {
    const contents = await readFile(
      this.persistence.sessionFile(sessionId, "diagnostics.ndjson"),
      "utf8",
    );
    return contents
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as EvidenceDiagnostic);
  }

  async append(sessionId: string, diagnostics: EvidenceDiagnostic[]): Promise<void> {
    if (diagnostics.length === 0) {
      return;
    }
    await this.enqueue(sessionId, async () => {
      await appendFile(
        this.persistence.sessionFile(sessionId, "diagnostics.ndjson"),
        `${diagnostics.map((item) => JSON.stringify(item)).join("\n")}\n`,
        { encoding: "utf8", mode: 0o600 },
      );
    });
  }

  async read(sessionId: string): Promise<EvidenceDiagnostic[]> {
    await (this.operations.get(sessionId) ?? Promise.resolve());
    return this.readFile(sessionId);
  }

  async clearRun(sessionId: string, runId: string): Promise<void> {
    await this.enqueue(sessionId, async () => {
      const retained = (await this.readFile(sessionId)).filter(
        (diagnostic) => diagnostic.recoverable.runId !== runId,
      );
      const contents =
        retained.length === 0 ? "" : `${retained.map((item) => JSON.stringify(item)).join("\n")}\n`;
      await writeTextAtomic(
        this.persistence.sessionFile(sessionId, "diagnostics.ndjson"),
        contents,
      );
    });
  }
}
