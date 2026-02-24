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
