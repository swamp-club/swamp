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
  consumeStream,
  createExtensionUnyankDeps,
  createLibSwampContext,
  extensionUnyank,
  extensionUnyankPreview,
} from "../../libswamp/mod.ts";
import { createExtensionUnyankRenderer } from "../../presentation/renderers/extension_unyank.ts";
import { createContext, type GlobalOptions } from "../context.ts";
import { UserError } from "../../domain/errors.ts";
import { parseExtensionRef } from "./extension_pull.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

export const extensionUnyankCommand = new Command()
  .name("unyank")
  .description(
    "Unyank an extension or specific version, restoring availability",
  )
  .example(
    "Unyank an extension",
    `swamp extension unyank @stack72/aws-ec2 --reason "accidental yank"`,
  )
  .example(
    "Unyank specific version",
    `swamp extension unyank @stack72/aws-ec2 2026.3.1`,
  )
  .arguments("<extension:string> [version:string]")
  .option("--reason <reason:string>", "Optional reason (audit log only)")
  .action(async function (
    options: AnyOptions,
    extension: string,
    version?: string,
  ) {
    const cliCtx = createContext(options as GlobalOptions, [
      "extension",
      "unyank",
    ]);
    cliCtx.logger.debug`Starting extension unyank`;

    const ref = parseExtensionRef(extension);
    const resolvedVersion = version ?? ref.version ?? null;

    const ctx = createLibSwampContext({ logger: cliCtx.logger });
    const deps = createExtensionUnyankDeps();
    const input = {
      extensionName: ref.name,
      version: resolvedVersion,
      reason: (options.reason as string | undefined) ?? null,
    };

    try {
      await extensionUnyankPreview(ctx, deps, input);
    } catch (error) {
      if ("code" in (error as Record<string, unknown>)) {
        throw new UserError((error as { message: string }).message);
      }
      throw error;
    }

    const renderer = createExtensionUnyankRenderer(cliCtx.outputMode);
    await consumeStream(
      extensionUnyank(ctx, deps, input),
      renderer.handlers(),
    );

    cliCtx.logger.debug("Extension unyank command completed");
  });
