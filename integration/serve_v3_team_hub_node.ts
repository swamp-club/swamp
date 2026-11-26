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

import type { FilesystemDatastoreConfig } from "../src/domain/datastore/datastore_config.ts";
import { registerFederationModelTypes } from "../src/domain/models/serve/federation_model_types.ts";
import { Fingerprint } from "../src/domain/serve/fingerprint.ts";
import { sampleFingerprintProps } from "../src/domain/serve/federation_test_helpers.ts";
import {
  SERVE_MEMBER_DATA_NAME,
  SERVE_MEMBER_MODEL_TYPE,
} from "../src/domain/models/serve/serve_member_names.ts";
import {
  v3RepositoryFactoryConfig,
  v3ServeControlPlaneAt,
} from "../src/infrastructure/datastore_v3/v3_repo_context.ts";
import { DefaultDatastorePathResolver } from "../src/infrastructure/persistence/default_datastore_path_resolver.ts";
import {
  createRepositoryContext,
  type RepositoryContext,
} from "../src/infrastructure/persistence/repository_factory.ts";
import {
  FederationHub,
  type MemberRecords,
} from "../src/serve/federation/federation_hub.ts";
import { HubSelfRecord } from "../src/serve/federation/hub_self_record.ts";
import {
  type FederationLeaderForward,
  routeFederationRequest,
} from "../src/serve/federation/hub_routes.ts";
import {
  repoMemberMethodRunner,
  repoMemberRecords,
} from "../src/serve/federation/member_record_store.ts";
import { MemberStatusSweeper } from "../src/serve/federation/member_status_sweeper.ts";
import "../src/domain/models/models.ts";

export interface TeamHubFacts {
  readonly sweeps: number;
  readonly selfWrites: number;
  readonly seenKeys: readonly string[];
  /** versions of each named member record, read on this node */
  readonly versions: Readonly<Record<string, readonly number[]>>;
}

export interface TeamHubNode {
  handle(req: Request, clientAddress: string): Promise<Response | null>;
  /** serve's startWhenLeading, once this node leads */
  lead(): void;
  createToken(name: string): Promise<string>;
  facts(names: readonly string[]): Promise<TeamHubFacts>;
  close(): Promise<void>;
}

export async function startTeamHubNode(options: {
  readonly env: (name: string) => string | undefined;
  readonly hubName: string;
  readonly repoDir: string;
  readonly config: FilesystemDatastoreConfig;
  readonly leader: FederationLeaderForward;
  readonly sweepIntervalMs: number;
}): Promise<TeamHubNode> {
  if (!await registerFederationModelTypes(options.env)) {
    throw new Error("the federation gate is off in this node");
  }
  const { repoDir, config } = options;
  // opened on first use: a follower forwards every write, so only a leader opens it
  let opened: Promise<RepositoryContext> | undefined;
  const context = () =>
    opened ??= (async () =>
      createRepositoryContext({
        repoDir,
        enableIndexing: false,
        datastoreResolver: new DefaultDatastorePathResolver(repoDir, config, {
          engine: "v3",
        }),
        ...await v3RepositoryFactoryConfig(repoDir, config),
      }))();
  const members: MemberRecords = {
    list: async () => await repoMemberRecords(await context()).list(),
    get: async (name) => await repoMemberRecords(await context()).get(name),
  };
  const store = v3ServeControlPlaneAt(config);
  const hub = new FederationHub({
    store,
    hubName: options.hubName,
    members,
    runMemberMethod: async (name, call) =>
      await repoMemberMethodRunner({ repoDir, repoContext: await context() })(
        name,
        call,
      ),
  });
  let sweeps = 0;
  let selfWrites = 0;
  const sweeper = new MemberStatusSweeper({
    hub: {
      sweep: () => {
        sweeps++;
        return hub.sweep();
      },
    },
    intervalMs: options.sweepIntervalMs,
  });
  const selfRecord = new HubSelfRecord({
    hub: {
      upsertSelf: (fingerprint) => {
        selfWrites++;
        return hub.upsertSelf(fingerprint);
      },
    },
    fingerprint: () =>
      Promise.resolve(
        Fingerprint.create(sampleFingerprintProps({ federationRole: "hub" })),
      ),
  });
  let leading = false;
  const leaderStarts: Array<() => void> = [];
  const startWhenLeading = (start: () => void) => {
    if (leading) start();
    else leaderStarts.push(start);
  };
  startWhenLeading(() => sweeper.start());
  selfRecord.start(startWhenLeading);
  return {
    handle: (req, clientAddress) =>
      routeFederationRequest(req, {
        hub,
        clientAddress: () => clientAddress,
        leader: options.leader,
      }),
    lead() {
      leading = true;
      for (const start of leaderStarts.splice(0)) start();
    },
    async createToken(name) {
      return (await hub.createToken(name)).plaintext;
    },
    async facts(names) {
      await selfRecord.settled();
      await hub.settled();
      const versions: Record<string, number[]> = {};
      if (opened !== undefined) {
        const repoContext = await context();
        for (const name of names) {
          const definition = await repoContext.definitionRepo.findByName(
            SERVE_MEMBER_MODEL_TYPE,
            name,
          );
          versions[name] = definition === null
            ? []
            : await repoContext.unifiedDataRepo.listVersions(
              SERVE_MEMBER_MODEL_TYPE,
              definition.id,
              SERVE_MEMBER_DATA_NAME,
            );
        }
      }
      return {
        sweeps,
        selfWrites,
        seenKeys: (await store.list("federation/seen/")).sort(),
        versions,
      };
    },
    async close() {
      await sweeper.stop();
      await selfRecord.settled();
      await hub.settled();
      if (opened !== undefined) (await opened).catalogStore.close();
    },
  };
}
