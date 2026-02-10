import { Command } from "@cliffy/command";
import {
  renderVersion,
  type VersionData,
} from "../../presentation/output/output.ts";
import { createContext, type GlobalOptions } from "../context.ts";

// This gets replaced by the compile script during release builds
export const VERSION = "20260206.200442.0-sha.";

export function getVersionData(): VersionData {
  return { version: VERSION };
}

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

export const versionCommand = new Command()
  .description("Display the version of swamp")
  .action(function (options: AnyOptions) {
    const ctx = createContext(options as GlobalOptions, ["version"]);
    ctx.logger.debug("Executing version command");
    ctx.logger
      .debug`Output mode: ${ctx.outputMode}, verbosity: ${ctx.verbosity}`;

    const data = getVersionData();
    renderVersion(data, ctx.outputMode);

    ctx.logger.debug("Version command completed");
  });
