import type { EventStore } from "./event-store";

export class EventSequence {
  private readonly values = new Map<string, number>();

  constructor(private readonly events: EventStore) {}

  async next(sessionId: string): Promise<number> {
    return this.events.runSessionOperation(sessionId, async () => {
      let current = this.values.get(sessionId);
      if (current === undefined) {
        const existing = await this.events.read(sessionId);
        current = existing.reduce((maximum, event) => Math.max(maximum, event.sequence), 0);
      }
      const value = current + 1;
      this.values.set(sessionId, value);
      return value;
    });
  }

  async reset(sessionId: string): Promise<void> {
    await this.events.runSessionOperation(sessionId, async () => {
      this.values.delete(sessionId);
    });
  }
}
