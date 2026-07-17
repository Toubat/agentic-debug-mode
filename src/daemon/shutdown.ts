export interface ShutdownController {
  promise: Promise<void>;
  begin(): void;
}

export function createShutdownController(): ShutdownController {
  let resolve: (() => void) | undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return {
    begin() {
      resolve?.();
    },
    promise,
  };
}
