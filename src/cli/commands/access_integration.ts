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
import { Ceiling, type CeilingEntry } from "../../domain/access/ceiling.ts";
import { generateIntegrationCredential } from "../../domain/access/integration_credential.ts";
import { INTEGRATION_ID_PATTERN } from "../../domain/access/client.ts";
import { UserError } from "../../domain/errors.ts";
import {
  INTEGRATION_DATA_NAME,
  INTEGRATION_ID_MAX_LENGTH,
  INTEGRATION_MODEL_TYPE,
  integrationDefinitionId,
  integrationDefinitionName,
  integrationIdTakenMessage,
  IntegrationSchema,
} from "../../domain/models/access/integration_model.ts";
import { findDefinitionByIdOrName } from "../../domain/models/model_lookup.ts";
import { modelRegistry } from "../../domain/models/model.ts";
import { reportRegistry } from "../../domain/reports/report_registry.ts";
import { vaultTypeRegistry } from "../../domain/vaults/vault_type_registry.ts";
import { isCustomDatastoreConfig } from "../../domain/datastore/datastore_config.ts";
import { pushNamespace } from "../../infrastructure/persistence/push_paths.ts";
import {
  createIntegrationListDeps,
  integrationList,
  type IntegrationListData,
  type IntegrationView,
  integrationView,
} from "../../libswamp/access/integration_list.ts";
import { modelMethodRun } from "../../libswamp/models/run.ts";
import { consumeStream, withDefaults } from "../../libswamp/stream.ts";
import {
  renderIntegration,
  renderIntegrationCeilingChanged,
  renderIntegrationList,
  renderIntegrationRegistered,
  renderIntegrationRevoked,
} from "../../presentation/output/access_integration_output.ts";
import type { AccessIntegrationListResponse } from "../../serve/protocol.ts";
import {
  type CommandRootUnitOptions,
  runCommandInRootUnit,
} from "../command_root_unit.ts";
import {
  createContext,
  type GlobalOptions,
  resolveRepoDir,
} from "../context.ts";
import { groupCommandAction } from "../group_action.ts";
import {
  commandTargetOf,
  requestNewerServerResponse,
  resolveServerTokenFromOptions,
  resolveServeUrl,
  runModelMethodOverServer,
  ServerResponseError,
  withRemoteOptions,
} from "../remote_run.ts";
import {
  acquireModelLocks,
  libSwampContextForRepo,
  type ModelLockResult,
  requireInitializedRepoReadOnly,
  requireInitializedRepoUnlocked,
} from "../repo_context.ts";
import { unknownCommandErrorHandler } from "../unknown_command_handler.ts";
import {
  buildModelMethodRunDeps,
  validateServerRepoExclusivity,
} from "./access_helpers.ts";
import type { RepositoryContext } from "../../infrastructure/persistence/repository_factory.ts";
import type { DatastoreSyncService } from "../../domain/datastore/datastore_sync_service.ts";
import { GIT_SHA } from "./version.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

function mayHaveRegistered(id: string, options: AnyOptions): string {
  const target = commandTargetOf(options);
  return `It may still have registered, and its credential can't be shown again. Check with: swamp access integration show ${id}${target}. The id was free when this command started, so if it's there now and nobody else registered it, revoke it with swamp access integration revoke ${id}${target}, and register a new id.`;
}

// the recovery hint advises a final revoke, so it must never be reached for an
// id that was already taken: that record could be a live integration
function refuseTakenId(id: string, known: IntegrationListData): void {
  const taken = known.integrations.find((item) => item.id === id);
  if (taken) throw new UserError(integrationIdTakenMessage(id, taken.state));
}

const INTEGRATION_TYPE_ARG = `@${INTEGRATION_MODEL_TYPE.normalized}`;

/** one --ceiling value is <actions>=<selector>, such as run,read=workflow:@acme/* */
function parseCeilingFlags(options: AnyOptions): Ceiling {
  const flags = (options.ceiling ?? []) as string[];
  if (options.empty && flags.length > 0) {
    throw new UserError("Cannot specify both --ceiling and --empty");
  }
  if (!options.empty && flags.length === 0) {
    throw new UserError(
      "Specify at least one --ceiling, or --empty to allow nothing",
    );
  }
  const entries = flags.map((flag) => {
    const separator = flag.indexOf("=");
    if (separator === -1) {
      throw new UserError(
        `Invalid --ceiling "${flag}": expected <actions>=<selector>, such as run,read=workflow:@acme/*`,
      );
    }
    return {
      actions: flag.slice(0, separator).split(",").map((a) => a.trim()),
      resource: flag.slice(separator + 1).trim(),
    } as unknown as CeilingEntry;
  });
  try {
    return Ceiling.parse({ version: 1, ceiling: entries });
  } catch (error) {
    throw new UserError(error instanceof Error ? error.message : String(error));
  }
}

/** an error frame can follow the write, so only a refused caller is sure */
function isDefiniteRefusal(error: unknown): boolean {
  if (error instanceof IntegrationRunRefused) return true;
  if (error instanceof ServerResponseError) {
    return error.code === "unauthorized" || error.code === "forbidden";
  }
  const message = error instanceof Error ? error.message : String(error);
  return /Could not connect|closed before it opened/.test(message);
}

function requireId(id: string): string {
  if (
    !INTEGRATION_ID_PATTERN.test(id) || id.length > INTEGRATION_ID_MAX_LENGTH
  ) {
    throw new UserError(
      `Invalid integration id "${id}": it is lowercase letters, digits and hyphens, starts with a letter or digit, and has at most ${INTEGRATION_ID_MAX_LENGTH} characters`,
    );
  }
  return id;
}

/** the method itself refused, before it wrote anything */
class IntegrationRunRefused extends UserError {}

interface MethodRun {
  readonly commandPath: string[];
  readonly id: string;
  readonly methodName: "register" | "setCeiling" | "revoke";
  readonly verb: string;
  /** called once the request may have reached serve */
  readonly onSending?: () => void;
  readonly inputs: Record<string, unknown>;
}

function recordOf(run: unknown): IntegrationView | undefined {
  const artifacts = (run as {
    dataArtifacts?: { name: string; attributes?: unknown }[];
  } | undefined)?.dataArtifacts;
  const parsed = IntegrationSchema.safeParse(
    artifacts?.find((a) => a.name === INTEGRATION_DATA_NAME)?.attributes,
  );
  return parsed.success ? integrationView(parsed.data) : undefined;
}

/**
 * A synced store can't refuse a stale write, so a cache that missed a revoke would
 * overwrite it. Reading fresh first leaves only writes that overlap this one.
 */
export async function pullLatestForIntegrationChange(
  syncService: Pick<DatastoreSyncService, "pullChanged"> | undefined,
  namespace: string | undefined,
  catalogStore: Pick<RepositoryContext["catalogStore"], "invalidate">,
): Promise<void> {
  if (!syncService) return;
  await syncService.pullChanged({ namespace });
  catalogStore.invalidate();
}

/**
 * onCleanupError is for a failed release: a change that never left this machine
 * must fail, because serve still acts on the old record.
 */
export async function runIntegrationChange(
  repoContext: Parameters<typeof runCommandInRootUnit>[0],
  run: Pick<MethodRun, "id" | "methodName" | "verb">,
  options: CommandRootUnitOptions,
  fn: () => Promise<void>,
): Promise<void> {
  const push = options.push;
  const pushFailures: unknown[] = [];
  await runCommandInRootUnit(repoContext, {
    ...options,
    push: push && (async (outcome) => {
      try {
        await push(outcome);
      } catch (error) {
        pushFailures.push(error);
        throw error;
      }
    }),
  }, fn);
  if (pushFailures.length === 0) return;
  const cause = pushFailures[0] instanceof Error
    ? pushFailures[0].message
    : String(pushFailures[0]);
  const retry = run.methodName === "register"
    ? ""
    : " Run the same command again to send it.";
  throw new UserError(
    `${run.verb} '${run.id}' was saved on this machine but didn't reach the datastore, so serve still uses the old record: ${cause}.${retry}`,
  );
}

/** every write is a behavior run, so serve's existing admin check decides it */
async function runIntegrationMethod(
  options: AnyOptions,
  run: MethodRun,
): Promise<IntegrationView | undefined> {
  const definitionName = integrationDefinitionName(run.id);
  let result: IntegrationView | undefined;
  const drain = async (
    stream: AsyncIterable<{ kind: string; [key: string]: unknown }>,
  ) => {
    for await (const event of stream) {
      if (event.kind === "error") {
        throw new IntegrationRunRefused(
          (event.error as { message?: string })?.message ?? "The run failed",
        );
      }
      if (event.kind === "cancelled") {
        throw new UserError(`${run.verb} '${run.id}' was cancelled`);
      }
      if (event.kind !== "completed") continue;
      if ((event.run as { status?: string })?.status === "failed") {
        throw new UserError(`${run.verb} '${run.id}' failed`);
      }
      result = recordOf(event.run);
    }
  };
  const server = resolveServeUrl(options.server as string | undefined);
  validateServerRepoExclusivity(server, options.repoDir as string | undefined);
  if (server) {
    const token = await resolveServerTokenFromOptions(server, options);
    // a user behavior could share this name, so only a listed record is acted on
    const known = await listIntegrations(options, run.commandPath);
    if (run.methodName === "register") {
      refuseTakenId(run.id, known);
    } else if (!known.integrations.some((item) => item.id === run.id)) {
      throw new UserError(`Integration '${run.id}' does not exist`);
    }
    run.onSending?.();
    await drain(
      runModelMethodOverServer({
        server,
        token,
        payload: {
          modelIdOrName: run.methodName === "register"
            ? INTEGRATION_TYPE_ARG
            : definitionName,
          methodName: run.methodName,
          inputs: run.inputs,
          skipAllReports: true,
          ...(run.methodName === "register"
            ? { typeArg: INTEGRATION_TYPE_ARG, definitionName }
            : {}),
        },
      }),
    );
    return result;
  }

  const ctx = createContext(options as GlobalOptions, run.commandPath);
  const { repoDir, repoContext, datastoreConfig, syncService, vaultsDir } =
    await requireInitializedRepoUnlocked({
      repoDir: resolveRepoDir(options.repoDir),
      outputMode: ctx.outputMode,
    });
  const namespace = isCustomDatastoreConfig(datastoreConfig)
    ? datastoreConfig.namespace
    : undefined;
  await pullLatestForIntegrationChange(
    syncService,
    namespace,
    repoContext.catalogStore,
  );
  if (run.methodName === "register") {
    refuseTakenId(run.id, await listFromRepo(repoContext));
  }
  await Promise.all([
    modelRegistry.ensureLoaded(),
    vaultTypeRegistry.ensureLoaded(),
    reportRegistry.ensureLoaded(),
  ]);
  const deps = buildModelMethodRunDeps(repoDir, repoContext, true, {
    vaultsDir,
  });
  const existing = await findDefinitionByIdOrName(
    repoContext.definitionRepo,
    definitionName,
  );
  const isIntegration = existing?.type.normalized ===
    INTEGRATION_MODEL_TYPE.normalized;
  if (run.methodName !== "register" && !isIntegration) {
    throw new UserError(`Integration '${run.id}' does not exist`);
  }
  // a first register locks the id's deterministic record too, so two machines
  // registering one id serialize and the second sees the first under the lock
  const lockResult = await acquireModelLocks(
    datastoreConfig,
    [{
      modelType: existing?.type.normalized ??
        INTEGRATION_MODEL_TYPE.normalized,
      modelId: existing?.definition.id ??
        await integrationDefinitionId(definitionName),
    }],
    repoDir,
    syncService,
    repoContext.catalogStore,
  );
  if (lockResult.synced) repoContext.catalogStore.invalidate();
  const modelLocks: ModelLockResult = lockResult;
  if (run.methodName === "register" && !existing) {
    try {
      refuseTakenId(run.id, await listFromRepo(repoContext));
    } catch (error) {
      await modelLocks.release();
      throw error;
    }
  }
  await runIntegrationChange(
    repoContext,
    run,
    {
      push: modelLocks?.push ??
        (syncService
          ? async () => await pushNamespace(syncService, namespace)
          : undefined),
      release: modelLocks?.release,
      onCleanupError: (cleanupError) => {
        ctx.logger.warn(
          "Failed to finish the integration change: {error}",
          {
            error: cleanupError instanceof Error
              ? cleanupError.message
              : String(cleanupError),
          },
        );
      },
    },
    async () => {
      run.onSending?.();
      await drain(
        modelMethodRun(libSwampContextForRepo(repoContext), deps, {
          modelIdOrName: run.methodName === "register"
            ? INTEGRATION_TYPE_ARG
            : definitionName,
          methodName: run.methodName,
          inputs: run.inputs,
          lastEvaluated: false,
          ...(run.methodName === "register"
            ? { typeArg: INTEGRATION_TYPE_ARG, definitionName }
            : {}),
          skipAllReports: true,
          swampSha: GIT_SHA || undefined,
        }) as AsyncIterable<{ kind: string; [key: string]: unknown }>,
      );
    },
  );
  return result;
}

async function listIntegrations(
  options: AnyOptions,
  commandPath: string[],
): Promise<IntegrationListData> {
  const ctx = createContext(options as GlobalOptions, commandPath);
  const server = resolveServeUrl(options.server as string | undefined);
  validateServerRepoExclusivity(server, options.repoDir as string | undefined);
  if (server) {
    const token = await resolveServerTokenFromOptions(server, options);
    const response = await requestNewerServerResponse<
      AccessIntegrationListResponse
    >(
      "integrations",
      { server, token },
      { type: "access.integration.list", payload: {} },
    );
    return response.data as unknown as IntegrationListData;
  }
  const { repoContext } = await requireInitializedRepoReadOnly({
    repoDir: resolveRepoDir(options.repoDir),
    outputMode: ctx.outputMode,
  });
  return await listFromRepo(repoContext);
}

async function listFromRepo(
  repoContext: RepositoryContext,
): Promise<IntegrationListData> {
  let data: IntegrationListData | undefined;
  await consumeStream(
    integrationList(
      libSwampContextForRepo(repoContext),
      createIntegrationListDeps(repoContext.dataQueryService),
    ),
    withDefaults({
      completed: (event) => {
        data = event.data;
      },
      error: (event) => {
        throw new UserError(event.error.message);
      },
    }),
  );
  return data ?? { integrations: [], count: 0 };
}

const repoDirOption = "Repository directory (env: SWAMP_REPO_DIR)";

const CEILING_DESCRIPTION =
  "What it may do, as <actions>=<workflow selector>; actions are run, read, approve and signal. Repeat for several";

const accessIntegrationRegisterCommand = withRemoteOptions(
  new Command()
    .name("register")
    .description(
      "Register an integration and show its credential, once. An id can't be used again after it is revoked",
    )
    .example(
      "Allow one workflow",
      "swamp access integration register slack-bot --name 'Slack bot' --ceiling 'run,read,approve=workflow:@acme/deploy'",
    )
    .arguments("<id:string>")
    .option("--name <name:string>", "A name people can read", {
      required: true,
    })
    .option("--ceiling <entry:string>", CEILING_DESCRIPTION, { collect: true })
    .option("--empty", "Allow nothing yet")
    .option(
      "--require-email-match",
      "When the app links a person, only the swamp-club account with the email the app names may approve",
    )
    .option("--repo-dir <dir:string>", repoDirOption),
).action(async function (options: AnyOptions, id: string) {
  const commandPath = ["access", "integration", "register"];
  const ctx = createContext(options as GlobalOptions, commandPath);
  requireId(id);
  const ceiling = parseCeilingFlags(options);
  const { credential, hash } = await generateIntegrationCredential(id);
  let sending = false;
  let view: IntegrationView | undefined;
  try {
    view = await runIntegrationMethod(options, {
      commandPath,
      id,
      methodName: "register",
      verb: "Registering",
      onSending: () => sending = true,
      inputs: {
        id,
        name: options.name as string,
        ceiling: ceiling.toDocument(),
        credentialHash: hash,
        ...(options.requireEmailMatch ? { requireEmailMatch: true } : {}),
      },
    });
  } catch (error) {
    if (!sending || isDefiniteRefusal(error)) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new UserError(`${message}\n${mayHaveRegistered(id, options)}`);
  }
  if (!view) {
    throw new UserError(
      `Registering '${id}' ended without a record.\n${
        mayHaveRegistered(id, options)
      }`,
    );
  }
  renderIntegrationRegistered(view, credential, ctx.outputMode);
});

const accessIntegrationListCommand = withRemoteOptions(
  new Command()
    .name("list")
    .description("List integrations: id, state, name and when registered")
    .example("List them", "swamp access integration list")
    .option("--repo-dir <dir:string>", repoDirOption),
).action(async function (options: AnyOptions) {
  const commandPath = ["access", "integration", "list"];
  const ctx = createContext(options as GlobalOptions, commandPath);
  renderIntegrationList(
    await listIntegrations(options, commandPath),
    ctx.outputMode,
  );
});

const accessIntegrationShowCommand = withRemoteOptions(
  new Command()
    .name("show")
    .description("Show an integration's state and ceiling")
    .example("Show one", "swamp access integration show slack-bot")
    .arguments("<id:string>")
    .option("--repo-dir <dir:string>", repoDirOption),
).action(async function (options: AnyOptions, id: string) {
  const commandPath = ["access", "integration", "show"];
  const ctx = createContext(options as GlobalOptions, commandPath);
  const data = await listIntegrations(options, commandPath);
  const view = data.integrations.find((item) => item.id === id);
  if (!view) throw new UserError(`Integration '${id}' does not exist`);
  renderIntegration(view, ctx.outputMode);
});

const accessIntegrationCeilingCommand = withRemoteOptions(
  new Command()
    .name("ceiling")
    .description(
      "Replace an integration's ceiling. It applies with no grant reload",
    )
    .example(
      "Narrow it to reading one workflow",
      "swamp access integration ceiling slack-bot --ceiling 'read=workflow:@acme/deploy'",
    )
    .arguments("<id:string>")
    .option("--ceiling <entry:string>", CEILING_DESCRIPTION, { collect: true })
    .option("--empty", "Allow nothing")
    .option("--repo-dir <dir:string>", repoDirOption),
).action(async function (options: AnyOptions, id: string) {
  const commandPath = ["access", "integration", "ceiling"];
  const ctx = createContext(options as GlobalOptions, commandPath);
  requireId(id);
  const ceiling = parseCeilingFlags(options);
  const view = await runIntegrationMethod(options, {
    commandPath,
    id,
    methodName: "setCeiling",
    verb: "Changing the ceiling of",
    inputs: { ceiling: ceiling.toDocument() },
  });
  if (!view) {
    throw new UserError(
      `Changing '${id}' ended without a record, so it may or may not have applied. Check with: swamp access integration show ${id}${
        commandTargetOf(options)
      }`,
    );
  }
  renderIntegrationCeilingChanged(view, ctx.outputMode);
});

const accessIntegrationRevokeCommand = withRemoteOptions(
  new Command()
    .name("revoke")
    .description(
      "Revoke an integration for good. It applies with no grant reload; runs it already started carry on",
    )
    .example("Revoke it", "swamp access integration revoke slack-bot")
    .arguments("<id:string>")
    .option("--repo-dir <dir:string>", repoDirOption),
).action(async function (options: AnyOptions, id: string) {
  const commandPath = ["access", "integration", "revoke"];
  const ctx = createContext(options as GlobalOptions, commandPath);
  requireId(id);
  const changed = await runIntegrationMethod(options, {
    commandPath,
    id,
    methodName: "revoke",
    verb: "Revoking",
    inputs: {},
  });
  // the method writes nothing when it was already revoked
  const view = changed ??
    (await listIntegrations(options, commandPath)).integrations.find((item) =>
      item.id === id
    );
  if (!view) throw new UserError(`Integration '${id}' does not exist`);
  // no record back isn't proof of a revoke, and scripts trust this reply
  if (changed === undefined && view.state !== "revoked") {
    throw new UserError(
      `Revoking '${id}' ended without a record, and it is listed as ${view.state}. Check with: swamp access integration show ${id}${
        commandTargetOf(options)
      }`,
    );
  }
  renderIntegrationRevoked(view, changed === undefined, ctx.outputMode);
});

export const accessIntegrationCommand = new Command()
  .name("integration")
  .description(
    "Manage integrations: apps an admin registers, limited by a ceiling",
  )
  .error(unknownCommandErrorHandler)
  .action(groupCommandAction)
  .command("register", accessIntegrationRegisterCommand)
  .command("list", accessIntegrationListCommand)
  .command("show", accessIntegrationShowCommand)
  .command("ceiling", accessIntegrationCeilingCommand)
  .command("revoke", accessIntegrationRevokeCommand);
