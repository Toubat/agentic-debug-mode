/**
 * Windows keeps a mandatory lock on files while a handle is open (a running
 * executable, a just-closed writer that has not fully released, etc.). Filesystem
 * operations against a transiently locked path surface as EPERM/EACCES/EBUSY —
 * and, for a recursive delete under Bun, occasionally as EFAULT ("bad address in
 * system call argument", errno -14) when a child handle is still closing — and
 * clear once the holder releases. A just-exited process (a spawned binary or the
 * daemon) can hold its locks for a noticeable fraction of a second under CI load,
 * so the retry window spans up to a few seconds. POSIX has no such behavior, so
 * these codes are rethrown immediately there.
 */
const WINDOWS_LOCK_RETRY_CODES = new Set(["EPERM", "EACCES", "EBUSY", "EFAULT"]);

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
    attempts = 25,
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
      // Escalate the backoff (capped) so early retries stay fast for the common
      // case while the overall budget still spans a slow handle release.
      await sleep(Math.min(10 * (attempt + 1), 200) + Math.floor(Math.random() * 10));
    }
  }
  // Unreachable: the loop returns on success or rethrows on the final attempt.
  throw new Error("retryOnWindowsLock exhausted its attempt budget without resolving");
}
