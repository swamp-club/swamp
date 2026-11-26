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

import { UserError } from "../../domain/errors.ts";
import { isCustomDatastoreConfig } from "../../domain/datastore/datastore_config.ts";
import { SERVE_MEMBER_MODEL_TYPE } from "../../domain/models/serve/serve_member_names.ts";
import { registerFederationModelTypes } from "../../domain/serve/federation_model_types.ts";
import {
  pushBoundOf,
  pushNamespace,
} from "../../infrastructure/persistence/push_paths.ts";
import type { OutputMode } from "../../presentation/output/output.ts";
import {
  FederationHub,
  federationHubEnabled,
  type MemberMethodRunner,
} from "../../serve/federation/federation_hub.ts";
import {
  repoMemberMethodRunner,
  repoMemberRecords,
} from "../../serve/federation/member_record_store.ts";
import {
  hubName,
  loadServeConfig,
  mergeServeOptions,
} from "../../serve/serve_config.ts";
import {
  acquireModelLocks,
  localAppControlPlane,
  localServeControlPlane,
  requireInitializedRepoReadOnly,
  requireInitializedRepoUnlocked,
  resolveDatastoreForRepo,
} from "../repo_context.ts";

export interface LocalHubOptions {
  readonly repoDir: string;
  /** the serve.yaml to read, as `swamp serve --config` takes it */
  readonly config?: string;
  readonly outputMode: OutputMode;
}

const env = (name: string) => Deno.env.get(name);

/** the hub's name, or a refusal unless the gate is on and serve.yaml is a version 2 hub */
async function localHubName(options: LocalHubOptions): Promise<string> {
  const merged = mergeServeOptions(
    loadServeConfig(options.config, options.repoDir),
    {},
    new Set(),
  );
  if (!federationHubEnabled(env, merged.federation)) {
    throw new UserError(
      "This repository's serve is not a federation hub: its serve.yaml needs " +
        "version: 2 and federation.role: hub. Pass --server to ask a running hub.",
    );
  }
  const resolution = await resolveDatastoreForRepo(options.repoDir);
  if (resolution.serveUpstream !== undefined) {
    throw new UserError(
      "This checkout writes through serve, which holds the hub's records. " +
        "Pass --server to ask it.",
    );
  }
  await registerFederationModelTypes(env);
  return hubName(merged.federation!);
}

const NO_MEMBER_WRITES: MemberMethodRunner = () =>
  Promise.reject(new Error("This command writes no member record"));

/** reads only: nothing is synced, locked or moved into team mode */
export async function openLocalHubForReading(
  options: LocalHubOptions,
): Promise<FederationHub> {
  const name = await localHubName(options);
  const { repoContext } = await requireInitializedRepoReadOnly({
    repoDir: options.repoDir,
    outputMode: options.outputMode,
  });
  return new FederationHub({
    store: await localAppControlPlane(options.repoDir),
    hubName: name,
    members: repoMemberRecords(repoContext),
    runMemberMethod: NO_MEMBER_WRITES,
  });
}

/** join tokens live in the control-plane store serve reads, never in swamp data */
export async function openLocalHubForTokens(
  options: LocalHubOptions,
): Promise<FederationHub> {
  const name = await localHubName(options);
  const { repoContext } = await requireInitializedRepoReadOnly({
    repoDir: options.repoDir,
    outputMode: options.outputMode,
  });
  return new FederationHub({
    store: await localServeControlPlane(options.repoDir),
    hubName: name,
    members: repoMemberRecords(repoContext),
    runMemberMethod: NO_MEMBER_WRITES,
  });
}

/**
 * holds the member's model lock while fn runs; the hub opens its own root unit
 * for the write, so fn must not run inside one
 */
export async function withLocalHubForMember<T>(
  options: LocalHubOptions,
  memberName: string,
  fn: (hub: FederationHub) => Promise<T>,
): Promise<T> {
  const name = await localHubName(options);
  const { repoDir, repoContext, datastoreConfig, syncService } =
    await requireInitializedRepoUnlocked({
      repoDir: options.repoDir,
      outputMode: options.outputMode,
    });
  const definition = await repoContext.definitionRepo.findByName(
    SERVE_MEMBER_MODEL_TYPE,
    memberName,
  );
  const locks = definition === null ? undefined : await acquireModelLocks(
    datastoreConfig,
    [{
      modelType: SERVE_MEMBER_MODEL_TYPE.normalized,
      modelId: definition.id,
    }],
    repoDir,
    syncService,
    repoContext.catalogStore,
  );
  if (locks?.synced) repoContext.catalogStore.invalidate();
  try {
    const namespace = isCustomDatastoreConfig(datastoreConfig)
      ? datastoreConfig.namespace
      : undefined;
    const hub = new FederationHub({
      store: await localServeControlPlane(repoDir),
      hubName: name,
      members: repoMemberRecords(repoContext),
      runMemberMethod: repoMemberMethodRunner({
        repoDir,
        repoContext,
        flush: locks?.push ??
          (syncService
            ? async () => {
              await pushNamespace(
                syncService,
                namespace,
                pushBoundOf(datastoreConfig),
              );
            }
            : undefined),
      }),
    });
    return await fn(hub);
  } finally {
    await locks?.release();
  }
}
