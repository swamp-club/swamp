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
import { UserError } from "../../domain/errors.ts";
import { isCustomDatastoreConfig } from "../../domain/datastore/datastore_config.ts";
import {
  DELEGATION_MODEL_TYPE,
  DelegationPhaseSchema,
} from "../../domain/models/access/delegation_model.ts";
import { pushNamespace } from "../../infrastructure/persistence/push_paths.ts";
import type { RepositoryContext } from "../../infrastructure/persistence/repository_factory.ts";
import {
  createDelegationEndDeps,
  delegationEnd,
  type DelegationEndData,
} from "../../libswamp/access/delegation_end.ts";
import {
  createDelegationListDeps,
  delegationList,
  type DelegationListData,
  type DelegationListInput,
  type DelegationViewState,
} from "../../libswamp/access/delegation_list.ts";
import { consumeStream, withDefaults } from "../../libswamp/stream.ts";
import {
  renderDelegation,
  renderDelegationEnded,
  renderDelegationList,
} from "../../presentation/output/access_delegation_output.ts";
import type {
  AccessDelegationEndResponse,
  AccessDelegationListResponse,
} from "../../serve/protocol.ts";
import { runCommandInRootUnit } from "../command_root_unit.ts";
import {
  createContext,
  type GlobalOptions,
  resolveRepoDir,
} from "../context.ts";
import { groupCommandAction } from "../group_action.ts";
import {
  requestNewerServerResponse,
  resolveServerTokenFromOptions,
  resolveServeUrl,
  withRemoteOptions,
} from "../remote_run.ts";
import {
  acquireModelLocks,
  libSwampContextForRepo,
  requireInitializedRepoReadOnly,
  requireInitializedRepoUnlocked,
} from "../repo_context.ts";
import { unknownCommandErrorHandler } from "../unknown_command_handler.ts";
import { validateServerRepoExclusivity } from "./access_helpers.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const STATES: readonly DelegationViewState[] = [
  ...DelegationPhaseSchema.options,
  "unreadable",
];

function requireId(id: string): string {
  if (!UUID.test(id)) {
    throw new UserError(
      `Invalid delegation id "${id}": it is a UUID, as swamp access delegation list shows`,
    );
  }
  return id;
}

function filterOf(options: AnyOptions): DelegationListInput {
  const state = options.state as string | undefined;
  if (state !== undefined && !STATES.includes(state as DelegationViewState)) {
    throw new UserError(
      `Invalid --state "${state}": expected one of ${STATES.join(", ")}`,
    );
  }
  const integrationId = options.integration as string | undefined;
  return {
    ...(integrationId !== undefined ? { integrationId } : {}),
    ...(state !== undefined ? { state: state as DelegationViewState } : {}),
  };
}

async function listDelegations(
  options: AnyOptions,
  commandPath: string[],
  filter: DelegationListInput,
): Promise<DelegationListData> {
  const ctx = createContext(options as GlobalOptions, commandPath);
  const server = resolveServeUrl(options.server as string | undefined);
  validateServerRepoExclusivity(server, options.repoDir as string | undefined);
  if (server) {
    const token = await resolveServerTokenFromOptions(server, options);
    const response = await requestNewerServerResponse<
      AccessDelegationListResponse
    >(
      "delegations",
      { server, token },
      { type: "access.delegation.list", payload: filter },
    );
    return response.data as unknown as DelegationListData;
  }
  const { repoContext } = await requireInitializedRepoReadOnly({
    repoDir: resolveRepoDir(options.repoDir),
    outputMode: ctx.outputMode,
  });
  return await listFromRepo(repoContext, filter);
}

async function listFromRepo(
  repoContext: RepositoryContext,
  filter: DelegationListInput,
): Promise<DelegationListData> {
  let data: DelegationListData | undefined;
  await consumeStream(
    delegationList(
      libSwampContextForRepo(repoContext),
      createDelegationListDeps(repoContext.dataQueryService),
      filter,
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
  return data ?? { delegations: [], count: 0 };
}

/** the record's model lock serializes this write with serve's link service */
async function endInRepo(
  options: AnyOptions,
  commandPath: string[],
  id: string,
): Promise<DelegationEndData> {
  const ctx = createContext(options as GlobalOptions, commandPath);
  const { repoDir, repoContext, datastoreConfig, syncService } =
    await requireInitializedRepoUnlocked({
      repoDir: resolveRepoDir(options.repoDir),
      outputMode: ctx.outputMode,
    });
  const namespace = isCustomDatastoreConfig(datastoreConfig)
    ? datastoreConfig.namespace
    : undefined;
  const locks = await acquireModelLocks(
    datastoreConfig,
    [{ modelType: DELEGATION_MODEL_TYPE.normalized, modelId: id }],
    repoDir,
    syncService,
    repoContext.catalogStore,
  );
  if (locks.synced) repoContext.catalogStore.invalidate();
  let data: DelegationEndData | undefined;
  await runCommandInRootUnit(
    repoContext,
    {
      push: locks.push ??
        (syncService
          ? async () => await pushNamespace(syncService, namespace)
          : undefined),
      pushWhen: "completed",
      release: locks.release,
      // a push that fails is thrown, so nobody is told an end serve never saw
    },
    async () => {
      await consumeStream(
        delegationEnd(
          libSwampContextForRepo(repoContext),
          createDelegationEndDeps(repoContext),
          { id, nowMs: Date.now() },
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
    },
  );
  if (data === undefined) {
    throw new UserError(`Ending delegation '${id}' ended without completing`);
  }
  return data;
}

const repoDirOption = "Repository directory (env: SWAMP_REPO_DIR)";

const accessDelegationListCommand = withRemoteOptions(
  new Command()
    .name("list")
    .description(
      "List delegations, newest first: who linked which integration, and its state",
    )
    .example("List them", "swamp access delegation list")
    .example(
      "Only one integration's live links",
      "swamp access delegation list --integration slack-bot --state issued",
    )
    .option("--integration <id:string>", "Only this integration's delegations")
    .option(
      "--state <state:string>",
      `Only delegations in this state: ${STATES.join(", ")}`,
    )
    .option("--repo-dir <dir:string>", repoDirOption),
).action(async function (options: AnyOptions) {
  const commandPath = ["access", "delegation", "list"];
  const ctx = createContext(options as GlobalOptions, commandPath);
  renderDelegationList(
    await listDelegations(options, commandPath, filterOf(options)),
    ctx.outputMode,
  );
});

const accessDelegationShowCommand = withRemoteOptions(
  new Command()
    .name("show")
    .description(
      "Show a delegation: its person, external user, life, and whether swamp-club knows it ended",
    )
    .example(
      "Show one",
      "swamp access delegation show 6f1c2a52-3b4d-4e5f-8a9b-0c1d2e3f4a5b",
    )
    .arguments("<id:string>")
    .option("--repo-dir <dir:string>", repoDirOption),
).action(async function (options: AnyOptions, id: string) {
  const commandPath = ["access", "delegation", "show"];
  const ctx = createContext(options as GlobalOptions, commandPath);
  requireId(id);
  const data = await listDelegations(options, commandPath, {});
  const view = data.delegations.find((item) => item.id === id);
  if (!view) throw new UserError(`Delegation '${id}' does not exist`);
  renderDelegation(view, ctx.outputMode);
});

const accessDelegationEndCommand = withRemoteOptions(
  new Command()
    .name("end")
    .description(
      "End a delegation for good: a running serve refuses its tokens within about 30 seconds, and swamp-club is told afterwards",
    )
    .example(
      "End one",
      "swamp access delegation end 6f1c2a52-3b4d-4e5f-8a9b-0c1d2e3f4a5b",
    )
    .arguments("<id:string>")
    .option("--repo-dir <dir:string>", repoDirOption),
).action(async function (options: AnyOptions, id: string) {
  const commandPath = ["access", "delegation", "end"];
  const ctx = createContext(options as GlobalOptions, commandPath);
  requireId(id);
  const server = resolveServeUrl(options.server as string | undefined);
  validateServerRepoExclusivity(server, options.repoDir as string | undefined);
  if (server) {
    const token = await resolveServerTokenFromOptions(server, options);
    const response = await requestNewerServerResponse<
      AccessDelegationEndResponse
    >(
      "ending delegations",
      { server, token },
      { type: "access.delegation.end", payload: { id } },
    );
    renderDelegationEnded(
      response.data as unknown as DelegationEndData,
      ctx.outputMode,
    );
    return;
  }
  renderDelegationEnded(
    await endInRepo(options, commandPath, id),
    ctx.outputMode,
  );
});

export const accessDelegationCommand = new Command()
  .name("delegation")
  .description(
    "Manage delegations: people linked to an integration through swamp-club",
  )
  .error(unknownCommandErrorHandler)
  .action(groupCommandAction)
  .command("list", accessDelegationListCommand)
  .command("show", accessDelegationShowCommand)
  .command("end", accessDelegationEndCommand);
