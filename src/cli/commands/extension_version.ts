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
import { UserError } from "../../domain/errors.ts";
import { parseExtensionManifest } from "../../domain/extensions/extension_manifest.ts";
import {
  consumeStream,
  createExtensionVersionDeps,
  createLibSwampContext,
  extensionVersion,
} from "../../libswamp/mod.ts";
import { createExtensionVersionRenderer } from "../../presentation/renderers/extension_version.ts";
import { loadIdentity } from "../load_identity.ts";

interface ExtensionVersionOptions extends GlobalOptions {
  manifest?: string;
}

export const extensionVersionCommand = new Command()
  .name("version")
  .description(
    "Show the latest published version and compute the next CalVer version for an extension",
  )
  .example(
    "Show version by name",
    "swamp extension version @stack72/aws-ec2",
  )
  .example(
    "From manifest",
    "swamp extension version --manifest extensions/models/my-model/manifest.json",
  )
  .arguments("[name:string]")
  .option(
    "--manifest <path:string>",
    "Read extension name from a manifest.yaml file",
  )
  .action(
    async function (options: ExtensionVersionOptions, name?: string) {
      const cliCtx = createContext(options, ["extension", "version"]);

      const extensionName = await resolveExtensionName(name, options.manifest);

      const ctx = createLibSwampContext({ logger: cliCtx.logger });
      const identity = await loadIdentity();
      const deps = createExtensionVersionDeps(identity);
      const renderer = createExtensionVersionRenderer(cliCtx.outputMode);

      await consumeStream(
        extensionVersion(ctx, deps, { extensionName }),
        renderer.handlers(),
      );
    },
  );

async function resolveExtensionName(
  name: string | undefined,
  manifestPath: string | undefined,
): Promise<string> {
  if (name && manifestPath) {
    throw new UserError(
      "Provide either an extension name or --manifest, not both.",
    );
  }

  if (manifestPath) {
    const content = await Deno.readTextFile(manifestPath);
    const manifest = parseExtensionManifest(content);
    return manifest.name;
  }

  if (name) {
    if (name.endsWith(".yaml") || name.endsWith(".yml")) {
      throw new UserError(
        `"${name}" looks like a file path. Did you mean --manifest ${name}?`,
      );
    }
    return name;
  }

  throw new UserError(
    "Provide an extension name (e.g., @myorg/my-ext) or use --manifest <path>.",
  );
}
