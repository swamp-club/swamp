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
import { consumeStream } from "../../libswamp/stream.ts";
import {
  createExtensionVisibilityDeps,
  type ExtensionVisibility,
  extensionVisibility,
} from "../../libswamp/extensions/visibility.ts";
import { createLibSwampContext } from "../../libswamp/context.ts";
import {
  createExtensionVisibilityRenderer,
  renderExtensionVisibilityCancelled,
} from "../../presentation/renderers/extension_visibility.ts";
import { createContext, type GlobalOptions } from "../context.ts";
import { UserError } from "../../domain/errors.ts";
import { parseExtensionRef } from "./extension_pull.ts";
import { loadIdentity } from "../load_identity.ts";
import { promptConfirmation } from "../prompt_helpers.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

export function parseVisibilityOptions(
  set: string | undefined,
  dryRun: boolean,
): { target: ExtensionVisibility | null; dryRun: boolean } {
  if (set !== undefined && set !== "public" && set !== "private") {
    throw new UserError(
      `Invalid visibility: "${set}". Must be one of: public, private.`,
    );
  }
  if (dryRun && set === undefined) {
    throw new UserError(
      "--dry-run needs --set: there is no change to preview when only reading visibility.",
    );
  }
  return { target: set ?? null, dryRun };
}

export const extensionVisibilityCommand = new Command()
  .name("visibility")
  .description(
    "Read or change an existing extension's visibility in the registry. Collective tokens need the extensions:push scope and can only make an extension public.",
  )
  .example(
    "Read the current visibility",
    "swamp extension visibility @myorg/ext --json",
  )
  .example(
    "Preview making a private extension public",
    "swamp extension visibility @myorg/ext --set public --dry-run",
  )
  .example(
    "Make a private extension public without a prompt",
    "swamp extension visibility @myorg/ext --set public --yes --json",
  )
  .arguments("<extension:string>")
  .option(
    "--set <visibility:string>",
    "Visibility to apply: 'public' or 'private'. Omit to read the current visibility.",
  )
  .option(
    "--dry-run",
    "Report what --set would change without changing it",
  )
  .option("-y, --yes", "Skip confirmation prompt")
  .option("-f, --force", "Skip confirmation prompt (alias for --yes)")
  .action(async function (options: AnyOptions, extension: string) {
    const cliCtx = createContext(options as GlobalOptions, [
      "extension",
      "visibility",
    ]);
    cliCtx.logger.debug`Starting extension visibility`;

    const ref = parseExtensionRef(extension);
    if (ref.version) {
      throw new UserError(
        `Visibility applies to the whole extension, not one version. Pass ${ref.name} without @${ref.version}.`,
      );
    }
    const { target, dryRun } = parseVisibilityOptions(
      options.set as string | undefined,
      options.dryRun === true,
    );

    if (
      target !== null && !dryRun && cliCtx.outputMode === "log" &&
      !options.yes && !options.force
    ) {
      const prompt = target === "public"
        ? `Make ${ref.name} public? Anyone will be able to pull it.`
        : `Make ${ref.name} private? Only collective members will be able to pull it.`;
      if (!await promptConfirmation(prompt)) {
        renderExtensionVisibilityCancelled(cliCtx.outputMode);
        return;
      }
    }

    const ctx = createLibSwampContext({ logger: cliCtx.logger });
    const deps = createExtensionVisibilityDeps(await loadIdentity());
    await consumeStream(
      extensionVisibility(ctx, deps, {
        extensionName: ref.name,
        target,
        dryRun,
      }),
      createExtensionVisibilityRenderer(cliCtx.outputMode).handlers(),
    );

    cliCtx.logger.debug("Extension visibility command completed");
  });
