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
  createExtensionUnyankDeps,
  createLibSwampContext,
  extensionUnyank,
  extensionUnyankPreview,
} from "../../libswamp/mod.ts";
import {
  createExtensionUnyankRenderer,
  renderExtensionUnyankCancelled,
} from "../../presentation/renderers/extension_unyank.ts";
import { createContext, type GlobalOptions } from "../context.ts";
import { UserError } from "../../domain/errors.ts";
import { parseExtensionRef } from "./extension_pull.ts";
import { loadIdentity } from "../load_identity.ts";
import { ReleaseChannel } from "../../domain/extensions/release_channel.ts";
import { promptConfirmation } from "../prompt_helpers.ts";

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
  .example(
    "Unyank only the stable channel",
    `swamp extension unyank @stack72/aws-ec2 --channel stable`,
  )
  .arguments("<extension:string> [version:string]")
  .option("--reason <reason:string>", "Optional reason (audit log only)")
  .option(
    "--channel <channel:string>",
    "Release channel to unyank: 'stable', 'beta', or 'rc' (default: all channels)",
  )
  .option("-y, --yes", "Skip confirmation prompt")
  .option("-f, --force", "Skip confirmation prompt (alias for --yes)")
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

    // Validate --channel if provided
    const channel = (options.channel as string | undefined) ?? null;
    if (
      channel !== null &&
      !ReleaseChannel.isValid(channel)
    ) {
      throw new UserError(
        `Invalid channel: "${channel}". Must be one of: stable, beta, rc.`,
      );
    }

    const ctx = createLibSwampContext({ logger: cliCtx.logger });
    const identity = await loadIdentity();
    const deps = createExtensionUnyankDeps(identity);
    const input = {
      extensionName: ref.name,
      version: resolvedVersion,
      channel,
      reason: (options.reason as string | undefined) ?? null,
    };

    let preview;
    try {
      preview = await extensionUnyankPreview(ctx, deps, input);
    } catch (error) {
      if ("code" in (error as Record<string, unknown>)) {
        throw new UserError((error as { message: string }).message);
      }
      throw error;
    }

    if (cliCtx.outputMode === "log" && !options.yes && !options.force) {
      const prompt = preview.version
        ? `Unyank ${preview.extensionName}@${preview.version}? This will restore availability.`
        : preview.channel
        ? `Unyank all ${preview.channel} versions of ${preview.extensionName}?`
        : `Unyank ALL versions of ${preview.extensionName}? This will restore availability and allow future pushes.`;
      const confirmed = await promptConfirmation(prompt);
      if (!confirmed) {
        renderExtensionUnyankCancelled(cliCtx.outputMode);
        return;
      }
    }

    const renderer = createExtensionUnyankRenderer(cliCtx.outputMode);
    await consumeStream(
      extensionUnyank(ctx, deps, input),
      renderer.handlers(),
    );

    cliCtx.logger.debug("Extension unyank command completed");
  });
