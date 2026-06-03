// Swamp, an Automation Framework
// Copyright (C) 2026 Elder Swamp Club, Inc.
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
  createExtensionUndeprecateDeps,
  createLibSwampContext,
  extensionUndeprecate,
  extensionUndeprecatePreview,
} from "../../libswamp/mod.ts";
import {
  createExtensionUndeprecateRenderer,
  renderExtensionUndeprecateCancelled,
} from "../../presentation/renderers/extension_undeprecate.ts";
import { createContext, type GlobalOptions } from "../context.ts";
import { UserError } from "../../domain/errors.ts";
import { parseExtensionRef } from "./extension_pull.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

async function promptConfirmation(message: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  await Deno.stdout.write(encoder.encode(`${message} [y/N] `));

  const buf = new Uint8Array(1024);
  const n = await Deno.stdin.read(buf);
  if (n === null) return false;

  const response = decoder.decode(buf.subarray(0, n)).trim().toLowerCase();
  return response === "y" || response === "yes";
}

export const extensionUndeprecateCommand = new Command()
  .name("undeprecate")
  .description(
    "Remove the deprecation status from an extension in the registry.",
  )
  .example(
    "Undeprecate an extension",
    "swamp extension undeprecate @jp/libvirt",
  )
  .arguments("<extension:string>")
  .option("-y, --yes", "Skip confirmation prompt")
  .action(async function (
    options: AnyOptions,
    extension: string,
  ) {
    const cliCtx = createContext(options as GlobalOptions, [
      "extension",
      "undeprecate",
    ]);
    cliCtx.logger.debug`Starting extension undeprecate`;

    const ref = parseExtensionRef(extension);

    const ctx = createLibSwampContext({ logger: cliCtx.logger });
    const deps = createExtensionUndeprecateDeps();
    const input = {
      extensionName: ref.name,
    };

    let preview;
    try {
      preview = await extensionUndeprecatePreview(ctx, deps, input);
    } catch (error) {
      if ("code" in (error as Record<string, unknown>)) {
        throw new UserError((error as { message: string }).message);
      }
      throw error;
    }

    if (cliCtx.outputMode === "log" && !options.yes) {
      const confirmed = await promptConfirmation(
        `Remove deprecation from ${preview.extensionName}?`,
      );
      if (!confirmed) {
        renderExtensionUndeprecateCancelled(cliCtx.outputMode);
        return;
      }
    }

    const renderer = createExtensionUndeprecateRenderer(cliCtx.outputMode);
    await consumeStream(
      extensionUndeprecate(ctx, deps, input),
      renderer.handlers(),
    );

    cliCtx.logger.debug("Extension undeprecate command completed");
  });
