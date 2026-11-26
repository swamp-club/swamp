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

import type { ControlPlaneStore } from "../../domain/datastore/control_plane_store.ts";
import type { DatastoreConfig } from "../../domain/datastore/datastore_config.ts";
import type { DatastoreEngine } from "../../domain/datastore/datastore_format.ts";
import type { DataRecord } from "../../domain/data/data_record.ts";
import { Fingerprint } from "../../domain/serve/fingerprint.ts";
import { registerFederationModelTypes } from "../../domain/serve/federation_model_types.ts";
import type { AuditEmitter } from "../../domain/serve_audit/audit_emitter.ts";
import type { RepositoryContext } from "../../infrastructure/persistence/repository_factory.ts";
import { YamlVaultConfigRepository } from "../../infrastructure/persistence/yaml_vault_config_repository.ts";
import { LockfileRepository } from "../../infrastructure/persistence/lockfile_repository.ts";
import { VERSION } from "../../infrastructure/runtime/build_info.ts";
import { createLibSwampContext } from "../../libswamp/context.ts";
import { userErrorFromSwampError } from "../../libswamp/errors.ts";
import { serveFingerprint } from "../../libswamp/serve/fingerprint.ts";
import { hubName, type MergedServeOptions } from "../../serve/serve_config.ts";
import { FederationAudit } from "../../serve/federation/federation_audit.ts";
import {
  FederationHub,
  federationHubEnabled,
} from "../../serve/federation/federation_hub.ts";
import { HubSelfRecord } from "../../serve/federation/hub_self_record.ts";
import {
  repoMemberMethodRunner,
  repoMemberRecords,
} from "../../serve/federation/member_record_store.ts";
import { MemberStatusSweeper } from "../../serve/federation/member_status_sweeper.ts";
import { fingerprintDatastoreFacts } from "./serve_fingerprint.ts";

export interface ServeFederationHubDeps {
  readonly env: (name: string) => string | undefined;
  readonly merged: MergedServeOptions;
  readonly serveYamlVersion: 1 | 2;
  readonly repoDir: string;
  readonly repoContext: RepositoryContext;
  readonly store: ControlPlaneStore;
  readonly datastoreConfig: DatastoreConfig;
  readonly datastoreEngine: DatastoreEngine;
  readonly lockfilePath: string;
  /** the settings in force, after any reload */
  readonly settings: () => MergedServeOptions;
  readonly auditEmitter: () => AuditEmitter | undefined;
  readonly instanceId: string;
  readonly startedAt: string;
  readonly flush: () => Promise<void>;
}

export interface ServeFederationHub {
  readonly hub: FederationHub;
  readonly audit: FederationAudit;
  readonly sweeper: MemberStatusSweeper;
  readonly selfRecord: HubSelfRecord;
}

/** undefined, building and registering nothing, unless the gate is on and this serve is a hub */
export async function buildServeFederationHub(
  deps: ServeFederationHubDeps,
): Promise<ServeFederationHub | undefined> {
  const federation = deps.merged.federation;
  if (!federationHubEnabled(deps.env, federation)) return undefined;
  await registerFederationModelTypes(deps.env);
  const audit = new FederationAudit({
    auditEmitter: deps.auditEmitter,
    instanceId: deps.instanceId,
  });
  const hub = new FederationHub({
    store: deps.store,
    hubName: hubName(federation!),
    members: repoMemberRecords(deps.repoContext),
    runMemberMethod: repoMemberMethodRunner({
      repoDir: deps.repoDir,
      repoContext: deps.repoContext,
      flush: deps.flush,
    }),
    audit,
  });
  const selfRecord = new HubSelfRecord({
    hub,
    fingerprint: () => collectHubFingerprint(deps),
  });
  return {
    hub,
    audit,
    sweeper: new MemberStatusSweeper({ hub }),
    selfRecord,
  };
}

// read as `swamp serve fingerprint` reads it, plus what only a running serve knows
async function collectHubFingerprint(
  deps: ServeFederationHubDeps,
): Promise<Fingerprint> {
  let fingerprint: Fingerprint | undefined;
  for await (
    const event of serveFingerprint(createLibSwampContext(), {
      buildVersion: () => VERSION,
      platform: () => ({ platform: Deno.build.os, arch: Deno.build.arch }),
      settings: deps.settings,
      serveYamlVersion: () => deps.serveYamlVersion,
      federationRole: () => "hub",
      datastore: () =>
        fingerprintDatastoreFacts(
          {
            datastoreConfig: deps.datastoreConfig,
            engine: deps.datastoreEngine,
          },
          deps.repoDir,
        ),
      vaultTypes: async () =>
        (await new YamlVaultConfigRepository(deps.repoDir).findAll())
          .map((vault) => vault.type),
      extensions: async () =>
        Object.entries(
          (await LockfileRepository.create(deps.lockfilePath)).getAllEntries(),
        ).map(([name, entry]) => ({ name, version: entry.version })),
      queryData: async (predicate) =>
        await deps.repoContext.dataQueryService.query(predicate, {
          loadAttributes: true,
        }) as DataRecord[],
    })
  ) {
    if (event.kind === "error") throw userErrorFromSwampError(event.error);
    if (event.kind === "completed") {
      fingerprint = Fingerprint.create({
        ...event.data.fingerprint,
        startedAt: deps.startedAt,
        ready: true,
      });
    }
  }
  if (fingerprint === undefined) {
    throw new Error("The hub's fingerprint was not collected");
  }
  return fingerprint;
}
