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
  createExtensionYankDeps,
  createLibSwampContext,
  extensionYank,
  extensionYankPreview,
} from "../../libswamp/mod.ts";
import {
  createExtensionYankRenderer,
  renderExtensionYankCancelled,
} from "../../presentation/renderers/extension_yank.ts";
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

export const extensionYankCommand = new Command()
  .name("yank")
  .description("Yank an extension or specific version from the registry")
  .arguments("<extension:string> [version:string]")
  .option("--reason <reason:string>", "Reason for yanking", { required: true })
  .option("-y, --yes", "Skip confirmation prompt")
  .action(async function (
    options: AnyOptions,
    extension: string,
    version?: string,
  ) {
    const cliCtx = createContext(options as GlobalOptions, [
      "extension",
      "yank",
    ]);
    cliCtx.logger.debug`Starting extension yank`;

    // Parse extension reference
    const ref = parseExtensionRef(extension);
    const resolvedVersion = version ?? ref.version ?? null;

    const ctx = createLibSwampContext({ logger: cliCtx.logger });
    const deps = createExtensionYankDeps();
    const input = {
      extensionName: ref.name,
      version: resolvedVersion,
      reason: options.reason as string,
    };

    // Phase 1: Preview — validate credentials and extension name
    let preview;
    try {
      preview = await extensionYankPreview(ctx, deps, input);
    } catch (error) {
      if ("code" in (error as Record<string, unknown>)) {
        throw new UserError((error as { message: string }).message);
      }
      throw error;
    }

    // Phase 2: Confirmation prompt (log mode only, unless --yes)
    if (cliCtx.outputMode === "log" && !options.yes) {
      const target = preview.version
        ? `${preview.extensionName}@${preview.version}`
        : `${preview.extensionName} (all versions)`;
      const confirmed = await promptConfirmation(
        `Yank ${target}? This will remove it from the registry.`,
      );
      if (!confirmed) {
        renderExtensionYankCancelled(cliCtx.outputMode);
        return;
      }
    }

    // Phase 3: Execute mutation
    const renderer = createExtensionYankRenderer(cliCtx.outputMode);
    await consumeStream(
      extensionYank(ctx, deps, input),
      renderer.handlers(),
    );

    cliCtx.logger.debug("Extension yank command completed");
  });
