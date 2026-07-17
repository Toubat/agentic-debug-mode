import { ensureDaemon } from "./cli/daemon-manager";
import { dispatch } from "./cli/dispatch";
import { exitCodeForError } from "./cli/exit-codes";
import { parseArgs } from "./cli/parse-args";
import { renderPretty } from "./cli/pretty-renderer";
import type { QueryWorkerInput } from "./cli/query-runner";
import { runDaemon } from "./daemon/main";
import { runJaq, runJaqFile } from "./native/query";
import { inspectProcess, terminateIfIdentityMatches } from "./native/system";

async function main(): Promise<number> {
  const argv = Bun.argv.slice(2);
  const command = argv[0];

  if (command === "__query-native") {
    const input = JSON.parse(await Bun.stdin.text()) as QueryWorkerInput;
    console.log(
      JSON.stringify(
        runJaqFile(
          input.program,
          input.path,
          input.hypotheses,
          input.watermark,
          input.slurp,
        ),
      ),
    );
    return 0;
  }

  if (command === "__ensure-daemon") {
    const connection = await ensureDaemon({
      homeDirectory: process.env.AGENT_DEBUG_MODE_HOME_OVERRIDE,
    });
    console.log(
      JSON.stringify(connection, (key, value) => (key === "controlToken" ? undefined : value)),
    );
    return 0;
  }

  if (command === "__daemon") {
    const nonceIndex = argv.indexOf("--nonce");
    const nonce = nonceIndex >= 0 ? argv[nonceIndex + 1] : undefined;
    if (!nonce) {
      console.error("Internal daemon startup requires --nonce");
      return 2;
    }
    await runDaemon({
      homeDirectory: process.env.AGENT_DEBUG_MODE_HOME_OVERRIDE,
      nonce,
    });
    return 0;
  }

  if (command === "__native-smoke") {
    const pid = process.pid;
    const processInspection = inspectProcess(pid);
    console.log(
      JSON.stringify({
        process: {
          exists: processInspection.exists,
          pid: processInspection.pid,
        },
        query: runJaq(".", { embedded: true }),
        termination: terminateIfIdentityMatches(pid, "smoke-test"),
      }),
    );
    return 0;
  }

  const parsed = parseArgs(argv);
  const output = await dispatch(parsed);
  const rendered = parsed.options.json === true ? JSON.stringify(output) : renderPretty(output);
  const stream = output.ok ? console.log : console.error;
  stream(rendered);
  return output.ok ? 0 : exitCodeForError(output.error.code);
}

process.exitCode = await main();
