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

import { type ArgumentValue, Command, StringType } from "@cliffy/command";
import { groupCommandAction } from "../group_action.ts";
import { unknownCommandErrorHandler } from "../unknown_command_handler.ts";
import { consumeStream } from "../../libswamp/stream.ts";
import { createLibSwampContext } from "../../libswamp/context.ts";
import {
  createRepoInitDeps,
  createRepoUpgradeDeps,
  repoInit,
  repoUpgrade,
} from "../../libswamp/repo/init.ts";
import type { ExtensionInstallDeps } from "../../libswamp/extensions/install.ts";
import { withManagedLockfileTransaction } from "../../libswamp/extensions/managed_lockfile_transaction.ts";
import { UserError } from "../../domain/errors.ts";
import {
  createRepoInitRenderer,
  createRepoUpgradeRenderer,
} from "../../presentation/renderers/repo_init.ts";
import {
  createContext,
  type GlobalOptions,
  resolveRepoDir,
} from "../context.ts";
import { createExtensionInstallDeps } from "../create_extension_install_deps.ts";
import { ManagedConfigUnresolvedError } from "../repo_context.ts";
import { createManagedLockfileTransaction } from "../managed_config_sync.ts";
import { RepoPath } from "../../domain/repo/repo_path.ts";
import { RepoMarkerRepository } from "../../infrastructure/persistence/repo_marker_repository.ts";
import { VERSION } from "../../infrastructure/runtime/build_info.ts";
import { VALID_AI_TOOLS } from "../ai_tool_parser.ts";
import { repoPruneCommand } from "./repo_prune.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

export class ToolNameType extends StringType {
  override complete(): string[] {
    return [...VALID_AI_TOOLS];
  }

  override parse(type: ArgumentValue): string {
    return type.value;
  }
}

/**
 * returns undefined when --tool was not passed, so the caller decides the
 * default (init uses claude, upgrade preserves marker.tools). Validates none
 * combined with others and dedupes.
 */
export function resolveToolFlag(toolOption: unknown): string[] | undefined {
  if (toolOption === undefined) return undefined;
  const raw = Array.isArray(toolOption) ? toolOption as string[] : [];
  if (raw.length === 0) return undefined;

  const hasNone = raw.includes("none");
  if (hasNone && raw.length > 1) {
    throw new UserError(
      "Cannot combine --tool none with other --tool values. " +
        "Use --tool none alone to clear the enrolled tool list.",
    );
  }
  if (hasNone) return [];

  const seen = new Set<string>();
  const result: string[] = [];
  for (const tool of raw) {
    if (!seen.has(tool)) {
      seen.add(tool);
      result.push(tool);
    }
  }
  return result;
}

export async function repoInitAction(
  options: AnyOptions,
  pathArg?: string,
): Promise<void> {
  const cliCtx = createContext(options as GlobalOptions, ["repo", "init"]);
  cliCtx.logger.debug`Initializing repository at: ${pathArg ?? "."}`;

  const tools = resolveToolFlag(options.tool);

  const ctx = createLibSwampContext({ logger: cliCtx.logger });
  const deps = createRepoInitDeps(VERSION);
  const renderer = createRepoInitRenderer(cliCtx.outputMode);
  await consumeStream(
    repoInit(ctx, deps, {
      path: pathArg ?? ".",
      force: !!options.force,
      tools,
      version: VERSION,
      serverAddress: options.server as string | undefined,
      // --no-vault sets this false; it is absent otherwise.
      vault: options.vault !== false,
    }),
    renderer.handlers(),
  );

  cliCtx.logger.debug("Repo init command completed");
}

const TOOL_FLAG_DESCRIPTION =
  "AI coding tool to configure for. Repeat to enroll multiple tools " +
  "(e.g. `--tool claude --tool kiro`). Duplicates are collapsed. " +
  "Use `--tool none` (alone) to skip tool scaffolding. Defaults to " +
  `\`claude\` when omitted. Built-in: ${VALID_AI_TOOLS.join(", ")}. ` +
  "Custom tools defined via `swamp agent setup` are also accepted.";

export const repoInitCommand = new Command()
  .description("Initialize a new swamp repository")
  .example("Initialize in current directory", "swamp repo init")
  .example("Initialize in a specific path", "swamp repo init ./my-project")
  .example(
    "Initialize for multiple AI tools",
    "swamp repo init --tool claude --tool kiro",
  )
  .example("Force reinitialize", "swamp repo init --force")
  .example("Initialize without the default vault", "swamp repo init --no-vault")
  .arguments("[path:string]")
  .option(
    "-f, --force",
    "Reinitialize if already exists (not an alias for --yes)",
  )
  .type("toolName", new ToolNameType())
  .option("-t, --tool <tool:toolName>", TOOL_FLAG_DESCRIPTION, {
    collect: true,
  })
  .option(
    "--no-vault",
    "Skip creating the default vault. By default init creates a local_encryption vault named `default` and records it as `defaultVault` in .swamp.yaml",
  )
  .option(
    "--server <url:string>",
    "Default serve URL for this repository — stored in .swamp.yaml as serverAddress (env: SWAMP_SERVE_URL overrides at runtime). A URL with credentials, a query string or a fragment is refused — give remote commands the token with --token, or store it with swamp auth server-login",
  )
  .action(repoInitAction);

export const repoUpgradeCommand = new Command()
  .description("Upgrade an existing swamp repository")
  .example(
    "Upgrade preserving the enrolled tools",
    "swamp repo upgrade",
  )
  .example(
    "Replace the enrolled tool list",
    "swamp repo upgrade --tool claude --tool kiro",
  )
  .arguments("[path:string]")
  .type("toolName", new ToolNameType())
  .option(
    "-t, --tool <tool:toolName>",
    "Replace the enrolled tool list. Repeat to enroll multiple tools " +
      "(e.g. `--tool claude --tool kiro`). Omit to preserve the existing " +
      "list and just bump the swamp version. `--tool none` clears.",
    { collect: true },
  )
  .option("--include-gitignore", "Manage a swamp section in .gitignore")
  .action(async function (options: AnyOptions, pathArg?: string) {
    const cliCtx = createContext(options as GlobalOptions, ["repo", "upgrade"]);
    cliCtx.logger.debug`Upgrading repository at: ${pathArg ?? "."}`;

    const tools = resolveToolFlag(options.tool);

    const ctx = createLibSwampContext({ logger: cliCtx.logger });
    const deps = createRepoUpgradeDeps(VERSION);

    // build the install deps so the upgrade runs the install pass afterward,
    // which completes any legacy-layout migration.
    const repoDir = resolveRepoDir(pathArg);
    // an unresolved managed config base, or a datastore lock that timed out
    // while resolving it, must not block the core upgrade: skip the install
    // pass and report why.
    let extensionInstallDeps: ExtensionInstallDeps | undefined;
    let extensionInstallSkippedReason: string | undefined;
    try {
      extensionInstallDeps = {
        ...await createExtensionInstallDeps(repoDir, cliCtx.logger),
        // An upgrade with nothing to restore must not need the datastore.
        refreshFromDatastore: false,
      };
    } catch (error) {
      const skippable = error instanceof ManagedConfigUnresolvedError ||
        (error instanceof UserError && error.code === "lock_timeout");
      if (!skippable) throw error;
      extensionInstallSkippedReason = error.message;
    }
    // The untrusted-collectives check reads the same lockfile the install
    // pass would; when that is unresolved, the check is skipped.
    const lockfilePath = extensionInstallDeps?.lockfilePath ?? null;
    // The install pass may migrate lockfile entries, made against the
    // datastore's lockfile and published as they land.
    const lockfileTransaction = lockfilePath
      ? createManagedLockfileTransaction(
        repoDir,
        await new RepoMarkerRepository().read(RepoPath.create(repoDir)),
        { lockfilePath, publish: true },
      )
      : undefined;

    const renderer = createRepoUpgradeRenderer(cliCtx.outputMode);
    await withManagedLockfileTransaction(
      lockfileTransaction,
      () =>
        consumeStream(
          repoUpgrade(ctx, deps, {
            path: pathArg ?? ".",
            tools,
            includeGitignore: options.includeGitignore as boolean | undefined,
            version: VERSION,
            extensionInstallDeps,
            extensionInstallSkippedReason,
            lockfilePath,
          }),
          renderer.handlers(),
        ),
    );

    cliCtx.logger.debug("Repo upgrade command completed");
  });

export const repoCommand = new Command()
  .name("repo")
  .description("Manage swamp repositories")
  .error(unknownCommandErrorHandler)
  .action(groupCommandAction)
  .command("init", repoInitCommand)
  .command("upgrade", repoUpgradeCommand)
  .command("prune", repoPruneCommand);
