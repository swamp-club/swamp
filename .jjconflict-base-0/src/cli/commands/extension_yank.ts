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
import { AuthRepository } from "../../infrastructure/persistence/auth_repository.ts";
import { UserError } from "../../domain/errors.ts";
import { ExtensionApiClient } from "../../infrastructure/http/extension_api_client.ts";
import { parseExtensionRef } from "./extension_pull.ts";
import {
  renderExtensionYank,
  renderExtensionYankCancelled,
} from "../../presentation/output/extension_yank_output.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

const SCOPED_NAME_PATTERN = /^@[a-z0-9_-]+\/[a-z0-9_-]+(\/[a-z0-9_-]+)*$/;
const DEFAULT_SERVER_URL = "https://swamp.club";

function resolveServerUrl(): string {
  return Deno.env.get("SWAMP_CLUB_URL") ?? DEFAULT_SERVER_URL;
}

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
    const ctx = createContext(options as GlobalOptions, ["extension", "yank"]);
    ctx.logger.debug`Starting extension yank`;

    // 1. Load auth credentials
    const authRepo = new AuthRepository();
    const credentials = await authRepo.load();
    if (!credentials) {
      throw new UserError(
        "Not authenticated. Run 'swamp auth login' first.",
      );
    }

    // 2. Parse extension reference
    const ref = parseExtensionRef(extension);

    if (!SCOPED_NAME_PATTERN.test(ref.name)) {
      throw new UserError(
        `Invalid extension name: "${ref.name}". Must match @collective/name pattern (lowercase, alphanumeric, hyphens, underscores, additional /segments allowed).`,
      );
    }

    // Version can come from the separate CLI arg or embedded in the ref (@ns/name@version)
    const resolvedVersion = version ?? ref.version ?? null;

    // 3. Confirmation prompt (log mode only, unless --yes)
    if (ctx.outputMode === "log" && !options.yes) {
      const target = resolvedVersion
        ? `${ref.name}@${resolvedVersion}`
        : `${ref.name} (all versions)`;
      const confirmed = await promptConfirmation(
        `Yank ${target}? This will remove it from the registry.`,
      );
      if (!confirmed) {
        renderExtensionYankCancelled(ctx.outputMode);
        return;
      }
    }

    // 4. Call the yank API
    const serverUrl = credentials.serverUrl ?? resolveServerUrl();
    const client = new ExtensionApiClient(serverUrl);
    await client.yankExtension(
      ref.name,
      resolvedVersion,
      options.reason,
      credentials.apiKey,
    );

    // 5. Render success
    renderExtensionYank(
      {
        name: ref.name,
        version: resolvedVersion,
        reason: options.reason,
      },
      ctx.outputMode,
    );

    ctx.logger.debug("Extension yank command completed");
  });
