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
import { groupCommandAction } from "../group_action.ts";
import {
  createContext,
  type GlobalOptions,
  resolveRepoDir,
} from "../context.ts";
import {
  acquireModelLocks,
  requireInitializedRepoReadOnly,
  requireInitializedRepoUnlocked,
} from "../repo_context.ts";
import { UserError } from "../../domain/errors.ts";
import { findDefinitionByIdOrName } from "../../domain/models/model_lookup.ts";
import { modelRegistry } from "../../domain/models/model.ts";
import { vaultTypeRegistry } from "../../domain/vaults/vault_type_registry.ts";
import { reportRegistry } from "../../domain/reports/report_registry.ts";
import { GIT_SHA } from "./version.ts";
import type { RepositoryContext } from "../../infrastructure/persistence/repository_factory.ts";
import {
  consumeStream,
  createLibSwampContext,
  modelMethodRun,
} from "../../libswamp/mod.ts";
import { createModelMethodRunRenderer } from "../../presentation/renderers/model_method_run.ts";
import {
  type Group,
  GROUP_MODEL_TYPE,
  GroupSchema,
} from "../../domain/models/access/group_model.ts";
import type { DataRecord } from "../../domain/data/data_record.ts";
import { createAccessGroupListRenderer } from "../../presentation/renderers/access_group.ts";
import { buildModelMethodRunDeps, LOCAL_PRINCIPAL } from "./access_helpers.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

async function queryGroups(
  repoContext: RepositoryContext,
): Promise<{ group: Group; instanceName: string }[]> {
  const records = await repoContext.dataQueryService.query(
    `modelType == "${GROUP_MODEL_TYPE.normalized}"`,
    { loadAttributes: true },
  );

  const results: { group: Group; instanceName: string }[] = [];
  for (const record of records) {
    const dataRecord = record as DataRecord;
    const parsed = GroupSchema.safeParse(dataRecord.attributes);
    if (parsed.success) {
      results.push({
        group: parsed.data,
        instanceName: dataRecord.modelName ?? "",
      });
    }
  }
  return results;
}

async function runGroupMethod(
  options: AnyOptions,
  instanceName: string,
  methodName: string,
  inputs: Record<string, unknown>,
  loggerCategory: string[],
  isDirectExecution: boolean,
): Promise<void> {
  const ctx = createContext(options as GlobalOptions, loggerCategory);
  const { repoDir, repoContext, datastoreConfig, syncService } =
    await requireInitializedRepoUnlocked({
      repoDir: resolveRepoDir(options.repoDir),
      outputMode: ctx.outputMode,
    });

  await Promise.all([
    modelRegistry.ensureLoaded(),
    vaultTypeRegistry.ensureLoaded(),
    reportRegistry.ensureLoaded(),
  ]);

  const deps = buildModelMethodRunDeps(repoDir, repoContext, isDirectExecution);

  const preResult = await findDefinitionByIdOrName(
    repoContext.definitionRepo,
    instanceName,
  );
  let flushModelLocks: (() => Promise<void>) | null = null;
  if (preResult) {
    const lockResult = await acquireModelLocks(
      datastoreConfig,
      [
        {
          modelType: preResult.type.normalized,
          modelId: preResult.definition.id,
        },
      ],
      repoDir,
      syncService,
      repoContext.catalogStore,
    );
    if (lockResult.synced) repoContext.catalogStore.invalidate();
    flushModelLocks = lockResult.flush;
  }

  try {
    const renderer = createModelMethodRunRenderer(ctx.outputMode, {
      modelName: instanceName,
      methodName,
    });

    const typeArg = isDirectExecution
      ? `@${GROUP_MODEL_TYPE.normalized}`
      : undefined;
    const definitionName = isDirectExecution ? instanceName : undefined;

    await consumeStream(
      modelMethodRun(createLibSwampContext(), deps, {
        modelIdOrName: isDirectExecution
          ? `@${GROUP_MODEL_TYPE.normalized}`
          : instanceName,
        methodName,
        inputs,
        lastEvaluated: false,
        typeArg,
        definitionName,
        skipAllReports: true,
        swampSha: GIT_SHA || undefined,
      }),
      renderer.handlers(),
    );

    if (renderer.runFailed()) {
      Deno.exitCode = 1;
    }
  } catch (error) {
    if (error instanceof UserError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new UserError(`Group operation failed: ${message}`);
  } finally {
    if (flushModelLocks) {
      try {
        await flushModelLocks();
      } catch (releaseError) {
        ctx.logger.warn(
          "Failed to release locks during cleanup: {error}",
          {
            error: releaseError instanceof Error
              ? releaseError.message
              : String(releaseError),
          },
        );
      }
    }
  }
}

const accessGroupCreateCommand = new Command()
  .name("create")
  .description("Create a local group")
  .example("Create a group", "swamp access group create release-managers")
  .arguments("<name:string>")
  .option(
    "--repo-dir <dir:string>",
    "Repository directory (env: SWAMP_REPO_DIR)",
  )
  .action(async function (options: AnyOptions, name: string) {
    await runGroupMethod(
      options,
      name,
      "create",
      { createdBy: LOCAL_PRINCIPAL },
      ["access", "group", "create"],
      true,
    );
  });

const accessGroupAddMemberCommand = new Command()
  .name("add-member")
  .description("Add a principal to a group")
  .example(
    "Add a user",
    "swamp access group add-member release-managers user:adam",
  )
  .arguments("<group:string> <principal:string>")
  .option(
    "--repo-dir <dir:string>",
    "Repository directory (env: SWAMP_REPO_DIR)",
  )
  .action(async function (
    options: AnyOptions,
    group: string,
    principal: string,
  ) {
    await runGroupMethod(
      options,
      group,
      "add-member",
      { principal },
      ["access", "group", "add-member"],
      false,
    );
  });

const accessGroupRemoveMemberCommand = new Command()
  .name("remove-member")
  .description("Remove a principal from a group")
  .example(
    "Remove a user",
    "swamp access group remove-member release-managers user:adam",
  )
  .arguments("<group:string> <principal:string>")
  .option(
    "--repo-dir <dir:string>",
    "Repository directory (env: SWAMP_REPO_DIR)",
  )
  .action(async function (
    options: AnyOptions,
    group: string,
    principal: string,
  ) {
    await runGroupMethod(
      options,
      group,
      "remove-member",
      { principal },
      ["access", "group", "remove-member"],
      false,
    );
  });

const accessGroupListCommand = new Command()
  .name("list")
  .description("List all groups")
  .example("List groups", "swamp access group list")
  .option(
    "--repo-dir <dir:string>",
    "Repository directory (env: SWAMP_REPO_DIR)",
  )
  .action(async function (options: AnyOptions) {
    const ctx = createContext(options as GlobalOptions, [
      "access",
      "group",
      "list",
    ]);
    const { repoContext } = await requireInitializedRepoReadOnly({
      repoDir: resolveRepoDir(options.repoDir),
      outputMode: ctx.outputMode,
    });

    await modelRegistry.ensureLoaded();

    const results = await queryGroups(repoContext);
    const groups = results.map((r) => r.group);
    const renderer = createAccessGroupListRenderer(ctx.outputMode);
    renderer.renderList(groups);
  });

const accessGroupMembersCommand = new Command()
  .name("members")
  .description("List members of a group")
  .example("Show members", "swamp access group members release-managers")
  .arguments("<name:string>")
  .option(
    "--repo-dir <dir:string>",
    "Repository directory (env: SWAMP_REPO_DIR)",
  )
  .action(async function (options: AnyOptions, name: string) {
    const ctx = createContext(options as GlobalOptions, [
      "access",
      "group",
      "members",
    ]);
    const { repoContext } = await requireInitializedRepoReadOnly({
      repoDir: resolveRepoDir(options.repoDir),
      outputMode: ctx.outputMode,
    });

    await modelRegistry.ensureLoaded();

    const results = await queryGroups(repoContext);
    const match = results.find((r) => r.group.name === name);
    if (!match) {
      throw new UserError(`Group not found: ${name}`);
    }

    const renderer = createAccessGroupListRenderer(ctx.outputMode);
    renderer.renderMembers(match.group);
  });

export const accessGroupCommand = new Command()
  .name("group")
  .description("Manage local groups")
  .action(groupCommandAction)
  .command("create", accessGroupCreateCommand)
  .command("add-member", accessGroupAddMemberCommand)
  .command("remove-member", accessGroupRemoveMemberCommand)
  .command("list", accessGroupListCommand)
  .command("members", accessGroupMembersCommand);
