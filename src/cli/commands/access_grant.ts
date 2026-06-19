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
  type Grant,
  GRANT_MODEL_TYPE,
  GrantSchema,
} from "../../domain/models/access/grant_model.ts";
import type { DataRecord } from "../../domain/data/data_record.ts";
import { createAccessGrantListRenderer } from "../../presentation/renderers/access_grant.ts";
import {
  buildModelMethodRunDeps,
  LOCAL_PRINCIPAL,
  parseActionsFlag,
  parseResourceFlag,
  validateServerRepoExclusivity,
} from "./access_helpers.ts";
import type { ModelMethodRunEvent } from "../../libswamp/mod.ts";
import {
  requestServerResponse,
  resolveServerToken,
  resolveServeUrl,
  runModelMethodOverServer,
} from "../../cli/remote_run.ts";
import type { AccessGrantListResponse } from "../../serve/protocol.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

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
  .option(
    "--server <url:string>",
    "Run through a 'swamp serve' server instead of locally (env: SWAMP_SERVE_URL)",
  )
  .option(
    "--token <token:string>",
    "Server token (falls back to stored credential)",
  )
  .action(async function (options: AnyOptions) {
    if (!options.allow && !options.deny) {
      throw new UserError("Either --allow or --deny must be specified");
    }
    if (options.allow && options.deny) {
      throw new UserError("Cannot specify both --allow and --deny");
    }

    const server = resolveServeUrl(options.server as string | undefined);

    validateServerRepoExclusivity(
      server,
      options.repoDir as string | undefined,
    );

    const effect = options.allow ? "allow" : "deny";
    const actions = parseActionsFlag(
      (options.allow ?? options.deny) as string,
    );
    const resource = parseResourceFlag(options.on as string);

    const instanceName = `grant-${crypto.randomUUID().slice(0, 8)}`;

    if (server) {
      const ctx = createContext(options as GlobalOptions, [
        "access",
        "grant",
        "create",
      ]);
      const token = await resolveServerToken(
        server,
        options.token as string | undefined,
      );
      const renderer = createModelMethodRunRenderer(ctx.outputMode, {
        modelName: instanceName,
        methodName: "create",
      });
      await consumeStream(
        runModelMethodOverServer({
          server,
          token,
          payload: {
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
            typeArg: `@${GRANT_MODEL_TYPE.normalized}`,
            definitionName: instanceName,
          },
        }) as AsyncIterable<ModelMethodRunEvent>,
        renderer.handlers(),
      );
      if (renderer.runFailed()) {
        Deno.exitCode = 1;
      }
      return;
    }

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
  .option("--on <resource:string>", "Filter by resource selector (exact match)")
  .option(
    "--server <url:string>",
    "List grants on a 'swamp serve' server instead of locally (env: SWAMP_SERVE_URL)",
  )
  .option(
    "--token <token:string>",
    "Server token (falls back to stored credential)",
  )
  .action(async function (options: AnyOptions) {
    const server = resolveServeUrl(options.server as string | undefined);

    validateServerRepoExclusivity(
      server,
      options.repoDir as string | undefined,
    );

    if (server) {
      const ctx = createContext(options as GlobalOptions, [
        "access",
        "grant",
        "list",
      ]);
      const token = await resolveServerToken(
        server,
        options.token as string | undefined,
      );
      const response = await requestServerResponse<AccessGrantListResponse>(
        { server, ...(token ? { token } : {}) },
        {
          type: "access.grant.list",
          payload: {
            subject: options.subject as string | undefined,
            resource: options.on as string | undefined,
          },
        },
      );
      const grants: Grant[] = [];
      for (const raw of response.grants) {
        const parsed = GrantSchema.safeParse(raw);
        if (parsed.success) {
          grants.push(parsed.data);
        }
      }
      const renderer = createAccessGrantListRenderer(ctx.outputMode);
      renderer.render(grants);
      return;
    }

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
  .option(
    "--server <url:string>",
    "Revoke a grant on a 'swamp serve' server instead of locally (env: SWAMP_SERVE_URL)",
  )
  .option(
    "--token <token:string>",
    "Server token (falls back to stored credential)",
  )
  .action(async function (options: AnyOptions, grantId: string) {
    const server = resolveServeUrl(options.server as string | undefined);

    validateServerRepoExclusivity(
      server,
      options.repoDir as string | undefined,
    );

    if (server) {
      const ctx = createContext(options as GlobalOptions, [
        "access",
        "grant",
        "revoke",
      ]);
      const token = await resolveServerToken(
        server,
        options.token as string | undefined,
      );
      const response = await requestServerResponse<AccessGrantListResponse>(
        { server, ...(token ? { token } : {}) },
        { type: "access.grant.list" },
      );
      const allGrants: { grant: Grant; instanceName: string }[] = [];
      for (const raw of response.grants) {
        const parsed = GrantSchema.safeParse(raw);
        if (parsed.success) {
          allGrants.push({
            grant: parsed.data,
            instanceName:
              (raw as Record<string, unknown>).instanceName as string ?? "",
          });
        }
      }
      const matches = allGrants.filter((r) => r.grant.id.startsWith(grantId));
      if (matches.length === 0) {
        throw new UserError(`Grant not found: ${grantId}`);
      }
      if (matches.length > 1) {
        throw new UserError(
          `Ambiguous grant ID prefix "${grantId}" — matches ${matches.length} grants. Use a longer prefix.`,
        );
      }
      const match = matches[0];
      if (match.grant.state === "revoked") {
        ctx.logger.info`Grant ${grantId} is already revoked`;
        return;
      }
      const renderer = createModelMethodRunRenderer(ctx.outputMode, {
        modelName: match.instanceName,
        methodName: "revoke",
      });
      await consumeStream(
        runModelMethodOverServer({
          server,
          token,
          payload: {
            modelIdOrName: match.instanceName,
            methodName: "revoke",
            inputs: {},
          },
        }) as AsyncIterable<ModelMethodRunEvent>,
        renderer.handlers(),
      );
      if (renderer.runFailed()) {
        Deno.exitCode = 1;
      }
      return;
    }

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
    const matches = allGrants.filter((r) => r.grant.id.startsWith(grantId));
    if (matches.length === 0) {
      throw new UserError(`Grant not found: ${grantId}`);
    }
    if (matches.length > 1) {
      throw new UserError(
        `Ambiguous grant ID prefix "${grantId}" — matches ${matches.length} grants. Use a longer prefix.`,
      );
    }
    const match = matches[0];
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
  .alias("policy")
  .description("Manage authorization grants")
  .action(groupCommandAction)
  .command("create", accessGrantCreateCommand)
  .command("list", accessGrantListCommand)
  .command("revoke", accessGrantRevokeCommand);
