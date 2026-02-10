import { Command } from "@cliffy/command";
import { createContext, type GlobalOptions } from "../context.ts";
import { VERSION } from "./version.ts";
import { Platform } from "../../domain/update/platform.ts";
import { UpdateService } from "../../domain/update/update_service.ts";
import { HttpUpdateChecker } from "../../infrastructure/update/http_update_checker.ts";
import { renderUpdateResult } from "../../presentation/output/update_output.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

export const updateCommand = new Command()
  .description("Update swamp to the latest version")
  .option("--check", "Check for updates without installing")
  .action(async function (options: AnyOptions) {
    const ctx = createContext(options as GlobalOptions, ["update"]);
    ctx.logger.debug("Executing update command");

    const platform = Platform.detect();
    ctx.logger.debug`Detected platform: ${platform}`;

    const checker = new HttpUpdateChecker();
    const binaryPath = Deno.execPath();
    const service = new UpdateService(checker, VERSION, binaryPath);

    const result = options.check
      ? await service.check(platform)
      : await service.update(platform);

    renderUpdateResult(result, ctx.outputMode);

    ctx.logger.debug("Update command completed");
  });
