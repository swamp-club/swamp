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
  createContext,
  type GlobalOptions,
  resolveRepoDir,
} from "../context.ts";
import {
  consumeStream,
  createLibSwampContext,
  createSourceAddDeps,
  EXTENSION_KINDS,
  sourceAdd,
} from "../../libswamp/mod.ts";
import { createSourceModifyRenderer } from "../../presentation/renderers/extension_source_modify.ts";
import type { ExtensionKind } from "../../libswamp/mod.ts";
import { UserError } from "../../domain/errors.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

export const extensionSourceAddCommand = new Command()
  .name("add")
  .description(
    "Add a local extension source (standard or direct-content layout).",
  )
  .example(
    "Standard layout (path contains extensions/<kind>/ subdirs)",
    "swamp extension source add ~/code/my-swamp-extensions",
  )
  .example(
    "Glob across sibling extension roots",
    'swamp extension source add "~/code/my-swamp-extensions/*"',
  )
  .example(
    "Direct-content layout (path holds extension files directly)",
    "swamp extension source add ~/code/my-vault-prototype",
  )
  .example(
    "Restrict to a single extension kind",
    "swamp extension source add ~/code/my-vaults --only vaults",
  )
  .arguments("<path:string>")
  .option(
    "--repo-dir <dir:string>",
    "Repository directory (env: SWAMP_REPO_DIR)",
  )
  .option(
    "--only <types:string>",
    "Only load these extension types (comma-separated: models,vaults,drivers,datastores,reports,workflows)",
  )
  .action(async function (options: AnyOptions, path: string) {
    const cliCtx = createContext(options as GlobalOptions, [
      "extension",
      "source",
      "add",
    ]);
    cliCtx.logger.debug`Adding extension source: ${path}`;

    const ctx = createLibSwampContext({ logger: cliCtx.logger });
    const deps = createSourceAddDeps(resolveRepoDir(options.repoDir));

    let only: ExtensionKind[] | undefined;
    if (options.only) {
      const kinds = (options.only as string).split(",").map((s: string) =>
        s.trim()
      );
      const validKinds = EXTENSION_KINDS as readonly string[];
      for (const kind of kinds) {
        if (!validKinds.includes(kind)) {
          throw new UserError(
            `Unknown extension kind '${kind}'. Expected one of: ${
              EXTENSION_KINDS.join(", ")
            }`,
          );
        }
      }
      only = kinds as ExtensionKind[];
    }

    const renderer = createSourceModifyRenderer(cliCtx.outputMode);
    await consumeStream(sourceAdd(ctx, deps, path, only), renderer.handlers());

    cliCtx.logger.debug("Extension source add command completed");
  });
