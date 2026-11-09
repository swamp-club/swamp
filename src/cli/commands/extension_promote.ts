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
  createContext,
  type GlobalOptions,
  resolveExtensionsDir,
  resolveRepoDir,
} from "../context.ts";
import { resolveManifestArgument } from "../resolve_manifest_path.ts";
import { parseExtensionManifest } from "../../domain/extensions/extension_manifest.ts";
import { UserError } from "../../domain/errors.ts";
import { parseExtensionVersionArgument } from "../../domain/extensions/extension_version_argument.ts";
import { consumeStream } from "../../libswamp/stream.ts";
import {
  createExtensionPromoteDeps,
  extensionPromote,
  extensionPromoteValidate,
} from "../../libswamp/extensions/promote.ts";
import { createLibSwampContext } from "../../libswamp/context.ts";
import {
  isScopedExtensionName,
  validateExtensionName,
} from "../../libswamp/extensions/pull.ts";
import { createExtensionPromoteRenderer } from "../../presentation/renderers/extension_promote.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

export type PromoteTarget =
  | { kind: "name"; name: string; version: string }
  | { kind: "manifest"; path: string };

/**
 * an @collective/name argument, alone or as name@version, is the name and needs
 * a version; anything else is a manifest path or directory whose manifest
 * supplies the version, so --from-channel does not apply.
 */
export function resolvePromoteTarget(
  target: string,
  versionArgument: string | undefined,
  fromChannel?: string,
): PromoteTarget {
  const separator = target.indexOf("@", 1);
  const namePart = separator === -1 ? target : target.slice(0, separator);
  if (isScopedExtensionName(namePart)) {
    const { name, version } = parseExtensionVersionArgument(
      target,
      versionArgument,
    );
    if (version === null) {
      throw new UserError(
        "Missing version: pass <extension> <version>, or a manifest path.",
      );
    }
    return { kind: "name", name, version };
  }
  if (versionArgument !== undefined) {
    // two arguments mean the name form, so a name that does not match keeps the
    // name error.
    try {
      validateExtensionName(target);
    } catch (error) {
      throw new UserError(
        `${
          (error as Error).message
        } To promote the version a manifest names, pass only the manifest path.`,
      );
    }
  }
  if (fromChannel !== undefined) {
    throw new UserError(
      "--from-channel cannot be used with a manifest: the registry reports which channel the version is on.",
    );
  }
  return { kind: "manifest", path: target };
}

/**
 * a single argument that is not @collective/name is read as a path, so a
 * mistyped name with its version left off would otherwise only hear that no
 * manifest exists.
 */
export function withExtensionNameHint(error: unknown): unknown {
  if (
    error instanceof UserError &&
    error.message.startsWith("Manifest file not found:")
  ) {
    // Same error object, so the paths marked for redaction stay marked.
    error.message +=
      "\nIf you meant an extension name, pass @collective/name <version>.";
  }
  return error;
}

export const extensionPromoteCommand = new Command()
  .name("promote")
  .description(
    "Promote an extension version to a higher release channel (beta→rc, beta→stable, rc→stable), by name and version or from a manifest path",
  )
  .example(
    "Promote beta to rc",
    "swamp extension promote @myorg/ext 2026.06.10.1 --channel rc",
  )
  .example(
    "Promote rc to stable",
    "swamp extension promote @myorg/ext 2026.06.10.1 --channel stable",
  )
  .example(
    "Promote the version a manifest names",
    "swamp extension promote extensions/behaviors/my-behavior/manifest.yaml --channel stable",
  )
  .arguments("<extension-or-manifest:string> [version:string]")
  .option(
    "--channel <channel:string>",
    "Target channel to promote to: 'rc' or 'stable'",
    { required: true },
  )
  .option(
    "--from-channel <fromChannel:string>",
    "Source channel ('beta' or 'rc'); skips direction validation if omitted",
  )
  .option(
    "--repo-dir <dir:string>",
    "Repository directory a relative manifest path resolves against (env: SWAMP_REPO_DIR)",
  )
  .option(
    "--extensions-dir <dir:string>",
    "Extensions root a relative manifest path resolves against (env: SWAMP_EXTENSIONS_DIR)",
  )
  .action(async function (
    options: AnyOptions,
    target: string,
    versionArgument: string | undefined,
  ) {
    const cliCtx = createContext(options as GlobalOptions, [
      "extension",
      "promote",
    ]);
    cliCtx.logger.debug`Starting extension promote`;

    const promoteTarget = resolvePromoteTarget(
      target,
      versionArgument,
      options.fromChannel as string | undefined,
    );
    let extension: string;
    let version: string;
    const fromManifest = promoteTarget.kind === "manifest";
    if (promoteTarget.kind === "manifest") {
      let absoluteManifestPath: string;
      try {
        ({ absoluteManifestPath } = await resolveManifestArgument({
          argument: promoteTarget.path,
          cwd: Deno.cwd(),
          repoDir: resolveRepoDir(options.repoDir),
          extensionsDir: resolveExtensionsDir(options.extensionsDir),
        }));
      } catch (error) {
        throw withExtensionNameHint(error);
      }
      const manifest = parseExtensionManifest(
        await Deno.readTextFile(absoluteManifestPath),
      );
      extension = manifest.name;
      version = manifest.version;
    } else {
      extension = promoteTarget.name;
      version = promoteTarget.version;
    }
    validateExtensionName(extension);

    const toChannel = options.channel as string;
    const fromChannel = options.fromChannel as string | undefined;
    const input = {
      extensionName: extension,
      version,
      toChannel,
      fromChannel,
      resolveFromChannel: fromManifest,
    };

    try {
      extensionPromoteValidate(input);
    } catch (error) {
      if ("code" in (error as Record<string, unknown>)) {
        throw new UserError((error as { message: string }).message);
      }
      throw error;
    }

    const ctx = createLibSwampContext({ logger: cliCtx.logger });
    const deps = createExtensionPromoteDeps();

    const renderer = createExtensionPromoteRenderer(cliCtx.outputMode);
    await consumeStream(
      extensionPromote(ctx, deps, input),
      renderer.handlers(),
    );

    cliCtx.logger.debug("Extension promote command completed");
  });
