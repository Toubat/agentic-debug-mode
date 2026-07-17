import { runJaq } from "./native/query";
import { inspectProcess, terminateIfIdentityMatches } from "./native/system";

async function main(): Promise<number> {
  const command = Bun.argv[2];

  if (command === "__native-smoke") {
    const pid = process.pid;
    console.log(
      JSON.stringify({
        process: inspectProcess(pid),
        query: runJaq(".", { embedded: true }),
        termination: terminateIfIdentityMatches(pid, "smoke-test"),
      }),
    );
    return 0;
  }

  console.error("Usage: debug-mode __native-smoke");
  return 2;
}

process.exitCode = await main();
