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
import { resolveModelType } from "../../domain/extensions/extension_auto_resolver.ts";
import { getAutoResolver } from "../auto_resolver_context.ts";
import { DefaultMethodExecutionService } from "../../domain/models/method_execution_service.ts";
import { modelRegistry } from "../../domain/models/model.ts";
import { vaultTypeRegistry } from "../../domain/vaults/vault_type_registry.ts";
import { reportRegistry } from "../../domain/reports/report_registry.ts";
import { VaultService } from "../../domain/vaults/vault_service.ts";
import { ExpressionEvaluationService } from "../../domain/expressions/expression_evaluation_service.ts";
import { runFileSink } from "../../infrastructure/logging/logger.ts";
import { GIT_SHA } from "./version.ts";
import { join } from "@std/path";
import {
  SWAMP_SUBDIRS,
  swampPath,
} from "../../infrastructure/persistence/paths.ts";
import { YamlDefinitionRepository } from "../../infrastructure/persistence/yaml_definition_repository.ts";
import { SecretRedactor } from "../../domain/secrets/mod.ts";
import { DataQueryService } from "../../domain/data/data_query_service.ts";
import type { RepositoryContext } from "../../infrastructure/persistence/repository_factory.ts";
import {
  consumeStream,
  createLibSwampContext,
  modelMethodRun,
  type ModelMethodRunDeps,
} from "../../libswamp/mod.ts";
import { createModelMethodRunRenderer } from "../../presentation/renderers/model_method_run.ts";
import {
  type Grant,
  GRANT_MODEL_TYPE,
  GrantSchema,
} from "../../domain/models/access/grant_model.ts";
import type { DataRecord } from "../../domain/data/data_record.ts";
import { createAccessGrantListRenderer } from "../../presentation/renderers/access_grant.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

const LOCAL_PRINCIPAL = "user:local";

export function parseResourceFlag(
  value: string,
): { kind: string; pattern: string } {
  const colonIdx = value.indexOf(":");
  if (colonIdx === -1) {
    throw new UserError(
      `Invalid resource selector "${value}": expected format "kind:pattern" (e.g. "workflow:@acme/*")`,
    );
  }
  const kind = value.substring(0, colonIdx);
  const pattern = value.substring(colonIdx + 1);
  const validKinds = ["workflow", "model", "data", "access"];
  if (!validKinds.includes(kind)) {
    throw new UserError(
      `Invalid resource kind "${kind}": must be one of ${
        validKinds.join(", ")
      }`,
    );
  }
  return { kind, pattern };
}

function parseActionsFlag(value: string): string[] {
  const actions = value.split(",").map((a) => a.trim()).filter((a) =>
    a.length > 0
  );
  const validActions = ["run", "read", "write", "admin"];
  for (const action of actions) {
    if (!validActions.includes(action)) {
      throw new UserError(
        `Invalid action "${action}": must be one of ${validActions.join(", ")}`,
      );
    }
  }
  if (actions.length === 0) {
    throw new UserError("At least one action is required");
  }
  return actions;
}

function buildModelMethodRunDeps(
  repoDir: string,
  repoContext: RepositoryContext,
  isDirectExecution: boolean,
): ModelMethodRunDeps {
  return {
    repoDir,
    lookupDefinition: (idOrName) =>
      findDefinitionByIdOrName(repoContext.definitionRepo, idOrName),
    getModelDef: (type) => resolveModelType(type, getAutoResolver()),
    createEvaluationService: () => {
      const dqs = new DataQueryService(
        repoContext.catalogStore,
        repoContext.unifiedDataRepo,
      );
      return new ExpressionEvaluationService(
        repoContext.definitionRepo,
        repoDir,
        {
          dataRepo: repoContext.unifiedDataRepo,
          dataQueryService: dqs,
        },
      );
    },
    loadEvaluatedDefinition: (type, name) =>
      repoContext.evaluatedDefinitionRepo.findByName(type, name),
    saveEvaluatedDefinition: (type, definition) =>
      repoContext.evaluatedDefinitionRepo.save(type, definition),
    createExecutionService: () => new DefaultMethodExecutionService(),
    createVaultService: () => VaultService.fromRepository(repoDir),
    dataRepo: repoContext.unifiedDataRepo,
    definitionRepo: repoContext.definitionRepo,
    outputRepo: repoContext.outputRepo,
    dataQueryService: new DataQueryService(
      repoContext.catalogStore,
      repoContext.unifiedDataRepo,
    ),
    createRunLog: async (modelType, method, definitionId) => {
      const redactor = new SecretRedactor();
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const logFilePath = join(
        swampPath(repoDir, SWAMP_SUBDIRS.outputs),
        modelType.normalized,
        method,
        `${definitionId}-${timestamp}.log`,
      );
      const logCategory: string[] = [];
      await runFileSink.register(
        logCategory,
        logFilePath,
        redactor,
        swampPath(repoDir),
      );
      return {
        logFilePath,
        redactor,
        cleanup: () => runFileSink.unregister(logCategory),
      };
    },
    createAndSaveDefinition: isDirectExecution
      ? async (type, definition) => {
        const autoDefRepo = new YamlDefinitionRepository(
          repoDir,
          undefined,
          swampPath(repoDir, SWAMP_SUBDIRS.autoDefinitions),
          false,
        );
        await autoDefRepo.save(type, definition);
      }
      : undefined,
    getDefinitionPath: isDirectExecution
      ? (type, id) => {
        return join(
          swampPath(repoDir, SWAMP_SUBDIRS.autoDefinitions),
          type.toDirectoryPath(),
          `${id}.yaml`,
        );
      }
      : undefined,
  };
}

export async function queryGrants(
  repoContext: RepositoryContext,
): Promise<{ grant: Grant; instanceName: string }[]> {
  const records = await repoContext.dataQueryService.query(
    `modelType == "${GRANT_MODEL_TYPE.normalized}"`,
    { loadAttributes: true },
  );

  const results: { grant: Grant; instanceName: string }[] = [];
  for (const record of records) {
    const dataRecord = record as DataRecord;
    const parsed = GrantSchema.safeParse(dataRecord.attributes);
    if (parsed.success) {
      results.push({
        grant: parsed.data,
        instanceName: dataRecord.modelName ?? "",
      });
    }
  }
  return results;
}

const accessGrantCreateCommand = new Command()
  .name("create")
  .description("Create a new authorization grant")
  .example(
    "Allow a group to run workflows",
    "swamp access grant create --subject idp-group:platform-eng --allow run --on 'workflow:@acme/*'",
  )
  .example(
    "With a CEL condition",
    "swamp access grant create --subject idp-group:platform-eng --allow run --on 'workflow:@acme/*' --when 'tags.env == \"staging\"'",
  )
  .option(
    "--repo-dir <dir:string>",
    "Repository directory (env: SWAMP_REPO_DIR)",
  )
  .option(
    "--subject <subject:string>",
    "Grant subject (e.g. user:adam, group:release-managers, idp-group:platform-eng)",
    { required: true },
  )
  .option("--allow <actions:string>", "Actions to allow (comma-separated)")
  .option("--deny <actions:string>", "Actions to deny (comma-separated)")
  .option(
    "--on <resource:string>",
    "Resource selector (e.g. workflow:@acme/*, model:@acme/deploy)",
    { required: true },
  )
  .option("--when <condition:string>", "Optional CEL condition")
  .action(async function (options: AnyOptions) {
    if (!options.allow && !options.deny) {
      throw new UserError("Either --allow or --deny must be specified");
    }
    if (options.allow && options.deny) {
      throw new UserError("Cannot specify both --allow and --deny");
    }

    const effect = options.allow ? "allow" : "deny";
    const actions = parseActionsFlag(
      (options.allow ?? options.deny) as string,
    );
    const resource = parseResourceFlag(options.on as string);

    const instanceName = `grant-${crypto.randomUUID().slice(0, 8)}`;

    const ctx = createContext(options as GlobalOptions, [
      "access",
      "grant",
      "create",
    ]);
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

    const deps = buildModelMethodRunDeps(repoDir, repoContext, true);

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
        methodName: "create",
      });

      await consumeStream(
        modelMethodRun(createLibSwampContext(), deps, {
          modelIdOrName: `@${GRANT_MODEL_TYPE.normalized}`,
          methodName: "create",
          inputs: {
            subject: options.subject as string,
            effect,
            actions,
            resourceKind: resource.kind,
            resourcePattern: resource.pattern,
            condition: options.when as string | undefined,
            source: "method",
            createdBy: LOCAL_PRINCIPAL,
          },
          lastEvaluated: false,
          typeArg: `@${GRANT_MODEL_TYPE.normalized}`,
          definitionName: instanceName,
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
      throw new UserError(`Grant creation failed: ${message}`);
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
  });

const accessGrantListCommand = new Command()
  .name("list")
  .description("List authorization grants")
  .example("List all grants", "swamp access grant list")
  .example(
    "Filter by subject",
    "swamp access grant list --subject idp-group:platform-eng",
  )
  .example(
    "Filter by resource",
    "swamp access grant list --on 'workflow:@acme/*'",
  )
  .option(
    "--repo-dir <dir:string>",
    "Repository directory (env: SWAMP_REPO_DIR)",
  )
  .option("--subject <subject:string>", "Filter by subject")
  .option("--on <resource:string>", "Filter by resource selector")
  .action(async function (options: AnyOptions) {
    const ctx = createContext(options as GlobalOptions, [
      "access",
      "grant",
      "list",
    ]);
    const { repoContext } = await requireInitializedRepoReadOnly({
      repoDir: resolveRepoDir(options.repoDir),
      outputMode: ctx.outputMode,
    });

    await modelRegistry.ensureLoaded();

    let results = await queryGrants(repoContext);

    results = results.filter((r) => r.grant.state === "active");

    if (options.subject) {
      const subjectFilter = options.subject as string;
      results = results.filter((r) => {
        const subjectStr = `${r.grant.subject.kind}:${r.grant.subject.name}`;
        return subjectStr === subjectFilter;
      });
    }

    if (options.on) {
      const resource = parseResourceFlag(options.on as string);
      results = results.filter((r) =>
        r.grant.resource.kind === resource.kind &&
        r.grant.resource.pattern === resource.pattern
      );
    }

    const grants = results.map((r) => r.grant);
    const renderer = createAccessGrantListRenderer(ctx.outputMode);
    renderer.render(grants);
  });

const accessGrantRevokeCommand = new Command()
  .name("revoke")
  .description("Revoke an authorization grant")
  .example("Revoke a grant", "swamp access grant revoke 7f3a1b2c-...")
  .arguments("<grant_id:string>")
  .option(
    "--repo-dir <dir:string>",
    "Repository directory (env: SWAMP_REPO_DIR)",
  )
  .action(async function (options: AnyOptions, grantId: string) {
    const ctx = createContext(options as GlobalOptions, [
      "access",
      "grant",
      "revoke",
    ]);
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

    const allGrants = await queryGrants(repoContext);
    const match = allGrants.find((r) => r.grant.id === grantId);
    if (!match) {
      throw new UserError(`Grant not found: ${grantId}`);
    }
    if (match.grant.state === "revoked") {
      ctx.logger.info`Grant ${grantId} is already revoked`;
      return;
    }

    const deps = buildModelMethodRunDeps(repoDir, repoContext, false);

    const preResult = await findDefinitionByIdOrName(
      repoContext.definitionRepo,
      match.instanceName,
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
        modelName: match.instanceName,
        methodName: "revoke",
      });

      await consumeStream(
        modelMethodRun(createLibSwampContext(), deps, {
          modelIdOrName: match.instanceName,
          methodName: "revoke",
          inputs: {},
          lastEvaluated: false,
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
      throw new UserError(`Grant revocation failed: ${message}`);
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
  });

export const accessGrantCommand = new Command()
  .name("grant")
  .description("Manage authorization grants")
  .action(groupCommandAction)
  .command("create", accessGrantCreateCommand)
  .command("list", accessGrantListCommand)
  .command("revoke", accessGrantRevokeCommand);
