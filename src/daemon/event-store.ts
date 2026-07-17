import { appendFile, readFile } from "node:fs/promises";
import type { NormalizedEvent } from "../domain/event";
import { writeTextAtomic } from "../platform/atomic-file";
import type { Persistence } from "./persistence";

export class EventStore {
  private readonly knownIds = new Map<string, Set<string>>();
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

  private async readFile(sessionId: string): Promise<NormalizedEvent[]> {
    const contents = await readFile(
      this.persistence.sessionFile(sessionId, "events.ndjson"),
      "utf8",
    );
    return contents
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as NormalizedEvent);
  }

  async append(event: NormalizedEvent): Promise<boolean> {
    let appended = false;
    await this.enqueue(event.sessionId, async () => {
      let ids = this.knownIds.get(event.sessionId);
      if (!ids) {
        ids = new Set((await this.readFile(event.sessionId)).map((item) => item.id));
        this.knownIds.set(event.sessionId, ids);
      }
      if (ids.has(event.id)) {
        return;
      }
      await appendFile(
        this.persistence.sessionFile(event.sessionId, "events.ndjson"),
        `${JSON.stringify(event)}\n`,
        { encoding: "utf8", mode: 0o600 },
      );
      ids.add(event.id);
      appended = true;
    });
    return appended;
  }

  async clearRun(sessionId: string, runId: string): Promise<void> {
    await this.enqueue(sessionId, async () => {
      const retained = (await this.readFile(sessionId)).filter((event) => event.runId !== runId);
      this.knownIds.set(sessionId, new Set(retained.map((event) => event.id)));
      const contents =
        retained.length === 0
          ? ""
          : `${retained.map((event) => JSON.stringify(event)).join("\n")}\n`;
      await writeTextAtomic(this.persistence.sessionFile(sessionId, "events.ndjson"), contents);
    });
  }

  async read(sessionId: string, runId?: string): Promise<NormalizedEvent[]> {
    await (this.operations.get(sessionId) ?? Promise.resolve());
    const events = await this.readFile(sessionId);
    return runId ? events.filter((event) => event.runId === runId) : events;
  }
}
