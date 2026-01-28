import { runCli } from "./src/cli/mod.ts";

if (import.meta.main) {
  await runCli(Deno.args);
}
