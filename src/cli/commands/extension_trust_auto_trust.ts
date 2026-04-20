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
import {
  createContext,
  type GlobalOptions,
  resolveRepoDir,
} from "../context.ts";
import {
  consumeStream,
  createLibSwampContext,
  createTrustAutoTrustDeps,
  trustAutoTrust,
} from "../../libswamp/mod.ts";
import { createTrustAutoTrustRenderer } from "../../presentation/renderers/trust_auto_trust.ts";
import { UserError } from "../../domain/errors.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

export const extensionTrustAutoTrustCommand = new Command()
  .name("auto-trust")
  .description(
    "Enable or disable auto-trusting membership collectives",
  )
  .example("Enable auto-trust", "swamp extension trust auto-trust enable")
  .example("Disable auto-trust", "swamp extension trust auto-trust disable")
  .arguments("<enabled:string>")
  .option(
    "--repo-dir <dir:string>",
    "Repository directory (env: SWAMP_REPO_DIR)",
  )
  .action(async function (options: AnyOptions, enabled: string) {
    const cliCtx = createContext(options as GlobalOptions, [
      "extension",
      "trust",
      "auto-trust",
    ]);

    let boolValue: boolean;
    if (enabled === "true" || enabled === "on" || enabled === "enable") {
      boolValue = true;
    } else if (
      enabled === "false" || enabled === "off" || enabled === "disable"
    ) {
      boolValue = false;
    } else {
      throw new UserError(
        `Invalid value '${enabled}'. Use 'true'/'on'/'enable' or 'false'/'off'/'disable'.`,
      );
    }

    cliCtx.logger.debug`Setting auto-trust: ${boolValue}`;

    const ctx = createLibSwampContext({ logger: cliCtx.logger });
    const deps = createTrustAutoTrustDeps(resolveRepoDir(options.repoDir));

    const renderer = createTrustAutoTrustRenderer(cliCtx.outputMode);
    await consumeStream(
      trustAutoTrust(ctx, deps, boolValue),
      renderer.handlers(),
    );

    cliCtx.logger.debug("Extension trust auto-trust command completed");
  });
