import { ensureDaemon } from "./cli/daemon-manager";
import { dispatch } from "./cli/dispatch";
import { exitCodeForError } from "./cli/exit-codes";
import { renderPretty } from "./cli/pretty-renderer";
import { CliParseError, parseCli } from "./cli/program";
import { runDaemon } from "./daemon/main";
import { runJaq } from "./native/query";
import { inspectProcess, terminateIfIdentityMatches } from "./native/system";

async function main(): Promise<number> {
  const argv = Bun.argv.slice(2);
  const command = argv[0];

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

  let parsed: Awaited<ReturnType<typeof parseCli>>;
  try {
    parsed = await parseCli(argv);
  } catch (error) {
    if (error instanceof CliParseError) {
      console.error(error.output || error.message);
      return error.exitCode;
    }
    throw error;
  }
  if ("helpText" in parsed) {
    process.stdout.write(parsed.helpText);
    return 0;
  }

  const output = await dispatch(parsed);
  const rendered = parsed.json ? JSON.stringify(output) : renderPretty(output);
  const stream = output.ok ? console.log : console.error;
  stream(rendered);
  return output.ok ? 0 : exitCodeForError(output.error.code);
}

process.exitCode = await main();
