import { describe, expect, test } from "bun:test";
import { retryOnWindowsLock } from "../../../src/platform/windows-lock-retry";

const errorWithCode = (code: string): NodeJS.ErrnoException => {
  const error = new Error(code) as NodeJS.ErrnoException;
  error.code = code;
  return error;
};

describe("retryOnWindowsLock", () => {
  test("retries a transiently locked operation on win32 and eventually succeeds", async () => {
    let calls = 0;
    const sleeps: number[] = [];
    const result = await retryOnWindowsLock(
      async () => {
        calls += 1;
        if (calls < 4) {
          throw errorWithCode("EBUSY");
        }
        return "done";
      },
      {
        platform: "win32",
        sleep: async (milliseconds) => {
          sleeps.push(milliseconds);
        },
      },
    );
    expect(result).toBe("done");
    expect(calls).toBe(4);
    expect(sleeps).toHaveLength(3);
  });

  test("rethrows after exhausting the attempt budget on win32", async () => {
    let calls = 0;
    await expect(
      retryOnWindowsLock(
        async () => {
          calls += 1;
          throw errorWithCode("EBUSY");
        },
        { platform: "win32", attempts: 3, sleep: async () => undefined },
      ),
    ).rejects.toThrow("EBUSY");
    expect(calls).toBe(3);
  });

  test("does not retry on posix, rethrowing the lock code immediately", async () => {
    let calls = 0;
    await expect(
      retryOnWindowsLock(
        async () => {
          calls += 1;
          throw errorWithCode("EPERM");
        },
        { platform: "linux", sleep: async () => undefined },
      ),
    ).rejects.toThrow("EPERM");
    expect(calls).toBe(1);
  });

  test("retries EFAULT from a recursive delete on win32", async () => {
    let calls = 0;
    const result = await retryOnWindowsLock(
      async () => {
        calls += 1;
        if (calls < 3) {
          throw errorWithCode("EFAULT");
        }
        return "removed";
      },
      { platform: "win32", sleep: async () => undefined },
    );
    expect(result).toBe("removed");
    expect(calls).toBe(3);
  });

  test("rethrows non-lock error codes without retrying on win32", async () => {
    let calls = 0;
    await expect(
      retryOnWindowsLock(
        async () => {
          calls += 1;
          throw errorWithCode("ENOENT");
        },
        { platform: "win32", sleep: async () => undefined },
      ),
    ).rejects.toThrow("ENOENT");
    expect(calls).toBe(1);
  });
});
