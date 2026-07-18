/**
 * Windows keeps a mandatory lock on files while a handle is open (a running
 * executable, a just-closed writer that has not fully released, etc.). Filesystem
 * operations against a transiently locked path surface as EPERM/EACCES/EBUSY and
 * clear within a few milliseconds once the holder releases. POSIX has no such
 * behavior, so these codes are rethrown immediately there.
 */
const WINDOWS_LOCK_RETRY_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export interface RetryOnWindowsLockOptions {
  sleep?: (milliseconds: number) => Promise<void>;
  attempts?: number;
  platform?: NodeJS.Platform;
}

/**
 * Run a filesystem operation, retrying briefly on Windows when the target is
 * transiently locked. The operation is retried up to `attempts` times with a
 * short randomized backoff; the final failure is rethrown. On non-Windows
 * platforms the operation runs exactly once and any error propagates unchanged.
 */
export async function retryOnWindowsLock<T>(
  operation: () => Promise<T>,
  {
    sleep = defaultSleep,
    attempts = 10,
    platform = process.platform,
  }: RetryOnWindowsLockOptions = {},
): Promise<T> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const retryable =
        platform === "win32" &&
        code !== undefined &&
        WINDOWS_LOCK_RETRY_CODES.has(code) &&
        attempt < attempts - 1;
      if (!retryable) {
        throw error;
      }
      await sleep(5 + Math.floor(Math.random() * 5));
    }
  }
  // Unreachable: the loop returns on success or rethrows on the final attempt.
  throw new Error("retryOnWindowsLock exhausted its attempt budget without resolving");
}
