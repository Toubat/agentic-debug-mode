export const IDLE_TIMEOUT_MILLISECONDS = 30 * 60_000;

export interface Clock {
  now(): number;
  setTimeout(callback: () => void, milliseconds: number): ReturnType<typeof setTimeout>;
  clearTimeout(handle: ReturnType<typeof setTimeout>): void;
}

export const systemClock: Clock = {
  clearTimeout(handle) {
    clearTimeout(handle);
  },
  now() {
    return Date.now();
  },
  setTimeout(callback, milliseconds) {
    return setTimeout(callback, milliseconds);
  },
};

export class ActivityTracker {
  private generation = 0;
  private lastActivity: number;
  private leases = 0;
  private stopped = false;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly clock: Clock,
    private readonly onIdle: () => void,
  ) {
    this.lastActivity = clock.now();
    this.armTimer(IDLE_TIMEOUT_MILLISECONDS);
  }

  touch(): void {
    if (this.stopped) {
      return;
    }
    this.lastActivity = this.clock.now();
    this.generation += 1;
    if (this.leases === 0) {
      this.armTimer(IDLE_TIMEOUT_MILLISECONDS);
    }
  }

  acquireLease(): () => void {
    if (this.stopped) {
      return () => undefined;
    }
    this.leases += 1;
    this.generation += 1;
    this.clearTimer();
    let released = false;
    return () => {
      if (released || this.stopped) {
        return;
      }
      released = true;
      this.leases -= 1;
      if (this.leases === 0) {
        this.touch();
      }
    };
  }

  stop(): void {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    this.generation += 1;
    this.clearTimer();
  }

  private armTimer(milliseconds: number): void {
    this.clearTimer();
    const generation = this.generation;
    this.timer = this.clock.setTimeout(() => {
      if (this.stopped || this.leases > 0 || generation !== this.generation) {
        return;
      }
      const remaining = IDLE_TIMEOUT_MILLISECONDS - (this.clock.now() - this.lastActivity);
      if (remaining > 0) {
        this.armTimer(remaining);
        return;
      }
      this.stopped = true;
      this.timer = undefined;
      this.onIdle();
    }, milliseconds);
    this.timer.unref?.();
  }

  private clearTimer(): void {
    if (!this.timer) {
      return;
    }
    this.clock.clearTimeout(this.timer);
    this.timer = undefined;
  }
}
