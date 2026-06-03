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
import { loadIdentity } from "../load_identity.ts";

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
  .description(
    "Yank an extension or specific version from the registry. Use `swamp extension unyank` to reverse.",
  )
  .example(
    "Yank every version (blocks all future pushes until unyanked)",
    `swamp extension yank @stack72/aws-ec2 --reason "security issue"`,
  )
  .example(
    "Yank one version (future versions can still be pushed)",
    `swamp extension yank @stack72/aws-ec2 2026.3.1 --reason "broken release"`,
  )
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
    const identity = await loadIdentity();
    const deps = createExtensionYankDeps(identity);
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
      const prompt = preview.version
        ? `Yank ${preview.extensionName}@${preview.version}? This will mark it yanked.`
        : `Yank ALL versions of ${preview.extensionName}? Future pushes will be blocked until you run \`swamp extension unyank\`.`;
      const confirmed = await promptConfirmation(prompt);
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
