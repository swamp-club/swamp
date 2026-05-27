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
  createExtensionDeprecateDeps,
  createLibSwampContext,
  extensionDeprecate,
  extensionDeprecatePreview,
} from "../../libswamp/mod.ts";
import {
  createExtensionDeprecateRenderer,
  renderExtensionDeprecateCancelled,
} from "../../presentation/renderers/extension_deprecate.ts";
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

export const extensionDeprecateCommand = new Command()
  .name("deprecate")
  .description(
    "Deprecate an extension in the registry. Use `swamp extension undeprecate` to reverse.",
  )
  .example(
    "Deprecate with a reason",
    `swamp extension deprecate @jp/libvirt --reason "No longer maintained"`,
  )
  .example(
    "Deprecate and point users to the successor",
    `swamp extension deprecate @jp/libvirt --reason "Merged into the collective extension" --superseded-by @bad-at-naming/libvirt`,
  )
  .arguments("<extension:string>")
  .option("--reason <reason:string>", "Reason for deprecation", {
    required: true,
  })
  .option(
    "--superseded-by <extension:string>",
    "Extension that supersedes this one",
  )
  .option("-y, --yes", "Skip confirmation prompt")
  .action(async function (
    options: AnyOptions,
    extension: string,
  ) {
    const cliCtx = createContext(options as GlobalOptions, [
      "extension",
      "deprecate",
    ]);
    cliCtx.logger.debug`Starting extension deprecate`;

    const ref = parseExtensionRef(extension);

    const ctx = createLibSwampContext({ logger: cliCtx.logger });
    const deps = createExtensionDeprecateDeps();
    const input = {
      extensionName: ref.name,
      reason: options.reason as string,
      supersededBy: (options.supersededBy as string) ?? null,
    };

    let preview;
    try {
      preview = await extensionDeprecatePreview(ctx, deps, input);
    } catch (error) {
      if ("code" in (error as Record<string, unknown>)) {
        throw new UserError((error as { message: string }).message);
      }
      throw error;
    }

    if (cliCtx.outputMode === "log" && !options.yes) {
      let prompt =
        `Deprecate ${preview.extensionName}? Users will see a deprecation notice.`;
      if (preview.supersededBy) {
        prompt =
          `Deprecate ${preview.extensionName} in favor of ${preview.supersededBy}? Users will see a deprecation notice.`;
      }
      const confirmed = await promptConfirmation(prompt);
      if (!confirmed) {
        renderExtensionDeprecateCancelled(cliCtx.outputMode);
        return;
      }
    }

    const renderer = createExtensionDeprecateRenderer(cliCtx.outputMode);
    await consumeStream(
      extensionDeprecate(ctx, deps, input),
      renderer.handlers(),
    );

    cliCtx.logger.debug("Extension deprecate command completed");
  });
