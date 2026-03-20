// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
//
// This file is part of Swamp.
//
// Swamp is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License version 3
// as published by the Free Software Foundation, with the Swamp
// Extension and Definition Exception (found in the "COPYING-EXCEPTION"
// file).
//
// Swamp is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with Swamp.  If not, see <https://www.gnu.org/licenses/>.

import { Command } from "@cliffy/command";
import { createContext, type GlobalOptions } from "../context.ts";
import { VERSION } from "./version.ts";
import { Platform } from "../../domain/update/platform.ts";
import {
  consumeStream,
  createLibSwampContext,
  createUpdateCheckDeps,
  updateCheck,
} from "../../libswamp/mod.ts";
import { createUpdateCheckRenderer } from "../../presentation/renderers/update_check.ts";
import { Spinner } from "../../presentation/spinner.ts";

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

    const spinner = ctx.outputMode !== "json" ? new Spinner() : null;

    try {
      const message = options.check
        ? "Checking for updates..."
        : "Updating swamp...";
      spinner?.start(message);

      const libCtx = createLibSwampContext({ logger: ctx.logger });
      const deps = createUpdateCheckDeps(VERSION, Deno.execPath());
      const renderer = createUpdateCheckRenderer(ctx.outputMode);
      await consumeStream(
        updateCheck(libCtx, deps, {
          checkOnly: options.check ?? false,
          platform,
        }),
        renderer.handlers(),
      );

      spinner?.stop();
    } catch (err) {
      spinner?.stop();
      throw err;
    }

    ctx.logger.debug("Update command completed");
  });
