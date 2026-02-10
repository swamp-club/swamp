import { runCli } from "./src/cli/mod.ts";
import { initializeLogging } from "./src/infrastructure/logging/logger.ts";
import { renderError } from "./src/presentation/output/error_output.ts";

if (import.meta.main) {
  try {
    await runCli(Deno.args);
  } catch (error) {
    await initializeLogging({
      jsonMode: Deno.args.includes("--json"),
    });
    renderError(error);
    Deno.exit(1);
  }
}
