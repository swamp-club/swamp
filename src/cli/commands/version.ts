import { Command } from "@cliffy/command";
import {
  renderVersion,
  type VersionData,
} from "../../presentation/output/output.tsx";
import { createContext, type GlobalOptions } from "../context.ts";

export const VERSION = "0.1.0";

export const FROG_HAIKU = `Old pond, still water—
A frog leaps in with a splash,
Silence returns slow.`;

export function getVersionData(): VersionData {
  return {
    version: VERSION,
    haiku: FROG_HAIKU,
  };
}

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

export const versionCommand = new Command()
  .description("Display the version of swamp and a frog haiku")
  .action(function (options: AnyOptions) {
    const ctx = createContext(options as GlobalOptions, "version");
    ctx.logger.debug("Executing version command");
    ctx.logger
      .debug`Output mode: ${ctx.outputMode}, verbosity: ${ctx.verbosity}`;

    const data = getVersionData();
    renderVersion(data, ctx.outputMode);

    ctx.logger.debug("Version command completed");
  });
