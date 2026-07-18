import { appendFile, readFile } from "node:fs/promises";
import type { EvidenceDiagnostic } from "../domain/diagnostic";
import { writeTextAtomic } from "../platform/atomic-file";
import type { Persistence } from "./persistence";

export class DiagnosticStore {
  private readonly knownIds = new Map<string, Set<string>>();

  constructor(private readonly persistence: Persistence) {}

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
    await this.persistence.runSessionOperation(sessionId, async () => {
      let ids = this.knownIds.get(sessionId);
      if (!ids) {
        ids = new Set((await this.readFile(sessionId)).map((item) => item.diagnosticId));
        this.knownIds.set(sessionId, ids);
      }
      const pendingIds = new Set(ids);
      const appended = diagnostics.filter((item) => {
        if (pendingIds.has(item.diagnosticId)) {
          return false;
        }
        pendingIds.add(item.diagnosticId);
        return true;
      });
      if (appended.length === 0) {
        return;
      }
      await appendFile(
        this.persistence.sessionFile(sessionId, "diagnostics.ndjson"),
        `${appended.map((item) => JSON.stringify(item)).join("\n")}\n`,
        { encoding: "utf8", mode: 0o600 },
      );
      for (const item of appended) {
        ids.add(item.diagnosticId);
      }
    });
  }

  async read(sessionId: string): Promise<EvidenceDiagnostic[]> {
    return this.persistence.runSessionOperation(sessionId, () => this.readFile(sessionId));
  }

  async clear(sessionId: string): Promise<void> {
    await this.persistence.runSessionOperation(sessionId, async () => {
      this.knownIds.set(sessionId, new Set());
      await writeTextAtomic(this.persistence.sessionFile(sessionId, "diagnostics.ndjson"), "");
    });
  }
}
