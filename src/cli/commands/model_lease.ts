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
  type CommandSyntax,
  definitionArgument,
  definitionNameType,
  recordDefiningModule,
  subcommandSyntax,
  withPreferredExample,
} from "./command_syntax.ts";
import {
  createContext,
  type GlobalOptions,
  resolveRepoDir,
} from "../context.ts";
import {
  requireInitializedRepoReadOnly,
  resolveDatastoreForRepo,
  v3LocationOf,
} from "../repo_context.ts";
import { groupCommandAction } from "../group_action.ts";
import { unknownCommandErrorHandler } from "../unknown_command_handler.ts";
import type { OutputMode } from "../../presentation/output/output.ts";
import { parseTimerDuration } from "../duration_parser.ts";
import { UserError } from "../../domain/errors.ts";
import { findDefinitionByIdOrName } from "../../domain/models/model_lookup.ts";
import { resolveLockTimeoutMs } from "../../domain/datastore/datastore_config.ts";
import {
  acquireExplicitLease,
  type ExplicitLease,
  ExplicitLeaseHeldError,
  ExplicitLeaseUnsupportedError,
  readExplicitLeases,
  releaseExplicitLease,
} from "../../infrastructure/datastore_v3/explicit_model_leases.ts";
import { serveUpstreamAt } from "../../infrastructure/datastore_v3/serve_upstream_registry.ts";
import { createLibSwampContext } from "../../libswamp/context.ts";
import { consumeStream } from "../../libswamp/stream.ts";
import { modelLockKey } from "../../libswamp/datastores/lock.ts";
import {
  modelLeaseAcquire,
  type ModelLeaseDeps,
  modelLeaseRelease,
  modelLeaseStatus,
  type ModelLeaseView,
} from "../../libswamp/models/lease.ts";
import {
  createModelLeaseAcquireRenderer,
  createModelLeaseReleaseRenderer,
  createModelLeaseStatusRenderer,
} from "../../presentation/renderers/model_lease.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

/** The preferred spelling: `swamp behavior lease`. */
export const BEHAVIOR_LEASE_SYNTAX: CommandSyntax = {
  invocation: "swamp behavior lease",
  surface: "behavior",
};

/** The legacy spelling: `swamp model lease`. */
export const MODEL_LEASE_SYNTAX: CommandSyntax = {
  invocation: "swamp model lease",
  surface: "model",
  preferred: `${BEHAVIOR_LEASE_SYNTAX.invocation} acquire my-server --for 30m`,
};

function viewOf(lease: ExplicitLease): ModelLeaseView {
  return {
    lockKey: lease.lockKey,
    fence: lease.fence,
    holdMs: lease.holdMs,
    expiresAt: lease.expiresAt,
  };
}

/**
 * The lease commands' dependencies for the checkout at `repoDir`: team
 * mode only when its datastore is written through serve, whose binding
 * names the local root the leases are recorded under.
 */
async function leaseDeps(
  repoDir: string,
  outputMode: OutputMode,
): Promise<ModelLeaseDeps> {
  const resolution = await resolveDatastoreForRepo(repoDir);
  const unsupported = (): never => {
    throw new Error("Internal error: lease operation outside team mode");
  };
  if (resolution.serveUpstream === undefined) {
    return {
      teamMode: false,
      lookupBehavior: unsupported,
      lockKeyOf: unsupported,
      acquire: unsupported,
      release: unsupported,
      list: unsupported,
    };
  }
  const root = (await v3LocationOf(resolution)).path;
  const binding = serveUpstreamAt(root);
  if (binding === undefined) {
    throw new Error("Internal error: the serve upstream is not bound");
  }
  const { repoContext } = await requireInitializedRepoReadOnly({
    repoDir,
    outputMode,
  });
  // Bounded by the client's own per-request timeout.
  const signal = new AbortController().signal;
  return {
    teamMode: true,
    lookupBehavior: async (idOrName) => {
      const found = await findDefinitionByIdOrName(
        repoContext.definitionRepo,
        idOrName,
      );
      return found === null || found === undefined ? undefined : {
        name: found.definition.name,
        type: found.type.normalized,
        id: found.definition.id,
      };
    },
    lockKeyOf: (behavior) =>
      modelLockKey(undefined, behavior.type, behavior.id),
    acquire: async (lockKey, holdMs) => {
      const client = binding.client();
      try {
        const { lease, existing } = await acquireExplicitLease(
          root,
          client,
          lockKey,
          holdMs,
          resolveLockTimeoutMs(),
          signal,
        );
        return { lease: viewOf(lease), existing };
      } catch (error) {
        if (
          error instanceof ExplicitLeaseHeldError ||
          error instanceof ExplicitLeaseUnsupportedError
        ) {
          throw new UserError(error.message);
        }
        throw error;
      } finally {
        client.close();
      }
    },
    release: async (lockKey) => {
      const client = binding.client();
      try {
        return await releaseExplicitLease(root, client, lockKey, signal);
      } finally {
        client.close();
      }
    },
    list: async () => (await readExplicitLeases(root)).map(viewOf),
  };
}

function createAcquireCommand(syntax: CommandSyntax) {
  return recordDefiningModule(
    withPreferredExample(
      new Command()
        .name("acquire")
        .description(
          `Hold a ${syntax.surface}'s lock at serve across commands, renewed by each command in this checkout (team mode)`,
        )
        .example(
          `Hold a ${syntax.surface} for 30 minutes`,
          `${syntax.invocation} my-server --for 30m`,
        )
        .arguments(
          `<${definitionArgument(syntax.surface)}:${
            definitionNameType(syntax.surface)
          }>`,
        )
        .option(
          "--for <duration:string>",
          "How long the lease is held between renewals (5s to 24h)",
          { required: true },
        )
        .option(
          "--repo-dir <dir:string>",
          "Repository directory (env: SWAMP_REPO_DIR)",
        ),
      syntax,
    ).action(
      // @ts-expect-error - Cliffy custom type returns unknown instead of string
      async function (options: AnyOptions, behavior: string) {
        const cliCtx = createContext(options as GlobalOptions, [
          "model",
          "lease",
          "acquire",
        ]);
        const holdMs = parseTimerDuration(options.for as string, "--for");
        const deps = await leaseDeps(
          resolveRepoDir(options.repoDir),
          cliCtx.outputMode,
        );
        await consumeStream(
          modelLeaseAcquire(
            createLibSwampContext({ logger: cliCtx.logger }),
            deps,
            { behavior, holdMs },
          ),
          createModelLeaseAcquireRenderer(cliCtx.outputMode).handlers(),
        );
      },
    ),
    import.meta.url,
  );
}

function createReleaseCommand(syntax: CommandSyntax) {
  return recordDefiningModule(
    withPreferredExample(
      new Command()
        .name("release")
        .description(
          `End the lease this checkout holds on a ${syntax.surface} at serve`,
        )
        .example(
          `Release a ${syntax.surface}'s lease`,
          `${syntax.invocation} my-server`,
        )
        .arguments(
          `<${definitionArgument(syntax.surface)}:${
            definitionNameType(syntax.surface)
          }>`,
        )
        .option(
          "--repo-dir <dir:string>",
          "Repository directory (env: SWAMP_REPO_DIR)",
        ),
      syntax,
    ).action(
      // @ts-expect-error - Cliffy custom type returns unknown instead of string
      async function (options: AnyOptions, behavior: string) {
        const cliCtx = createContext(options as GlobalOptions, [
          "model",
          "lease",
          "release",
        ]);
        const deps = await leaseDeps(
          resolveRepoDir(options.repoDir),
          cliCtx.outputMode,
        );
        await consumeStream(
          modelLeaseRelease(
            createLibSwampContext({ logger: cliCtx.logger }),
            deps,
            { behavior },
          ),
          createModelLeaseReleaseRenderer(cliCtx.outputMode).handlers(),
        );
      },
    ),
    import.meta.url,
  );
}

function createStatusCommand(syntax: CommandSyntax) {
  return recordDefiningModule(
    withPreferredExample(
      new Command()
        .name("status")
        .description("List the leases this checkout holds at serve")
        .example("List held leases", syntax.invocation)
        .option(
          "--repo-dir <dir:string>",
          "Repository directory (env: SWAMP_REPO_DIR)",
        ),
      syntax,
    ).action(async function (options: AnyOptions) {
      const cliCtx = createContext(options as GlobalOptions, [
        "model",
        "lease",
        "status",
      ]);
      const deps = await leaseDeps(
        resolveRepoDir(options.repoDir),
        cliCtx.outputMode,
      );
      await consumeStream(
        modelLeaseStatus(
          createLibSwampContext({ logger: cliCtx.logger }),
          deps,
        ),
        createModelLeaseStatusRenderer(cliCtx.outputMode).handlers(),
      );
    }),
    import.meta.url,
  );
}

/**
 * `swamp model lease` / `swamp behavior lease` (swamp-club#4121): hold a
 * behavior's lock at serve across commands.
 */
export function createModelLeaseCommand(syntax: CommandSyntax) {
  // A legacy leaf names its preferred spelling, as every model twin does.
  const sub = (word: string, example: string): CommandSyntax => ({
    ...subcommandSyntax(syntax, word),
    ...(syntax.surface === "model"
      ? { preferred: `${BEHAVIOR_LEASE_SYNTAX.invocation} ${word}${example}` }
      : {}),
  });
  const command = new Command()
    .name("lease")
    .description(
      `Hold ${syntax.surface} locks at serve across commands (team mode)`,
    )
    .error(unknownCommandErrorHandler)
    .action(groupCommandAction)
    .command(
      "acquire",
      createAcquireCommand(sub("acquire", " my-server --for 30m")),
    )
    .command("release", createReleaseCommand(sub("release", " my-server")))
    .command("status", createStatusCommand(sub("status", "")));
  return recordDefiningModule(command, import.meta.url);
}
