import { dispatch } from "./cli/dispatch";
import { exitCodeForError } from "./cli/exit-codes";
import { parseArgs } from "./cli/parse-args";
import { renderPretty } from "./cli/pretty-renderer";
import { runJaq } from "./native/query";
import { inspectProcess, terminateIfIdentityMatches } from "./native/system";

async function main(): Promise<number> {
  const argv = Bun.argv.slice(2);
  const command = argv[0];

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

  const parsed = parseArgs(argv);
  const output = await dispatch(parsed);
  const rendered =
    parsed.options.json === true
      ? JSON.stringify(output)
      : renderPretty(output);
  const stream = output.ok ? console.log : console.error;
  stream(rendered);
  return output.ok ? 0 : exitCodeForError(output.error.code);
}

process.exitCode = await main();
