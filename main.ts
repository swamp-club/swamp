import { runCli } from "./src/cli/mod.ts";
import { getOutputModeFromArgs } from "./src/cli/context.ts";
import { renderError } from "./src/presentation/output/error_output.tsx";

if (import.meta.main) {
  try {
    await runCli(Deno.args);
  } catch (error) {
    renderError(error, getOutputModeFromArgs(Deno.args));
    Deno.exit(1);
  }
}
