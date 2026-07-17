import type { EventStore } from "./event-store";

export class EventSequence {
  private readonly values = new Map<string, number>();
  private readonly operations = new Map<string, Promise<void>>();

  constructor(private readonly events: EventStore) {}

  async next(sessionId: string): Promise<number> {
    let value: number | undefined;
    const previous = this.operations.get(sessionId) ?? Promise.resolve();
    const operation = previous.then(async () => {
      let current = this.values.get(sessionId);
      if (current === undefined) {
        const existing = await this.events.read(sessionId);
        current = existing.reduce((maximum, event) => Math.max(maximum, event.sequence), 0);
      }
      value = current + 1;
      this.values.set(sessionId, value);
    });
    const settled = operation.then(
      () => undefined,
      () => undefined,
    );
    this.operations.set(sessionId, settled);
    try {
      await operation;
      if (value === undefined) {
        throw new Error("Event sequence was not assigned");
      }
      return value;
    } finally {
      if (this.operations.get(sessionId) === settled) {
        this.operations.delete(sessionId);
      }
    }
  }
}
