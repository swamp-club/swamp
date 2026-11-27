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
import type {
  Fingerprint,
  FingerprintProps,
  FingerprintRuntime,
} from "../../domain/serve/fingerprint.ts";
import { InstanceId } from "../../domain/serve/instance_id.ts";
import { registerFederationModelTypes } from "../../domain/models/serve/federation_model_types.ts";
import type { AuditEmitter } from "../../domain/serve_audit/audit_emitter.ts";
import type { RepositoryContext } from "../../infrastructure/persistence/repository_factory.ts";
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
import {
  collectServeFingerprint,
  FingerprintFactsCache,
} from "./serve_federation_fingerprint.ts";

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
  /** this node's place in its team, read each time the fingerprint is */
  readonly team: () => Promise<FingerprintProps["team"]>;
  /** serve's own readiness, as a member reports it */
  readonly ready: () => boolean;
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
  });
  const facts = new FingerprintFactsCache();
  const selfRecord = new HubSelfRecord({
    hub,
    fingerprint: () => collectHubFingerprint(deps, facts),
    seen: {
      instanceId: InstanceId.create(deps.instanceId),
      runtime: () => hubRuntime(deps),
    },
  });
  return {
    hub,
    audit,
    sweeper: new MemberStatusSweeper({ hub }),
    selfRecord,
  };
}

/** what only the running hub knows, read fresh each time */
export async function hubRuntime(
  deps: Pick<ServeFederationHubDeps, "team" | "startedAt" | "ready">,
): Promise<FingerprintRuntime> {
  return {
    team: await deps.team(),
    startedAt: deps.startedAt,
    ready: deps.ready(),
  };
}

async function collectHubFingerprint(
  deps: ServeFederationHubDeps,
  facts: FingerprintFactsCache,
): Promise<Fingerprint> {
  const { team, ready } = await hubRuntime(deps);
  return await collectServeFingerprint(deps, {
    role: "hub",
    team,
    startedAt: deps.startedAt,
    ready: ready ?? false,
  }, facts);
}
