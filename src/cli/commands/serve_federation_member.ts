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
import type { FingerprintProps } from "../../domain/serve/fingerprint.ts";
import {
  countWorkers,
  type FingerprintWorkerFacts,
} from "../../domain/serve/fingerprint_collector.ts";
import { getSwampLogger } from "../../infrastructure/logging/logger.ts";
import type { MergedServeOptions } from "../../serve/serve_config.ts";
import { federationMemberEnabled } from "../../serve/federation/federation_hub.ts";
import { HubClient } from "../../serve/federation/hub_client.ts";
import { HubLinkStore } from "../../serve/federation/hub_link_store.ts";
import {
  MemberCheckInService,
  type MemberCheckInServiceOptions,
} from "../../serve/federation/member_check_in_service.ts";
import {
  MemberCredentialVault,
  type MemberSecretVault,
} from "../../serve/federation/member_credential_vault.ts";
import type { ServeTeamMode } from "../../serve/federation/serve_team.ts";
import {
  collectServeFingerprint,
  type ServeFingerprintSources,
} from "./serve_federation_fingerprint.ts";

const logger = getSwampLogger(["serve", "federation", "member"]);

export interface ServeFederationMemberDeps extends ServeFingerprintSources {
  readonly env: (name: string) => string | undefined;
  readonly merged: MergedServeOptions;
  readonly store: ControlPlaneStore;
  /** the _token-secrets control-plane vault */
  readonly tokenSecrets: MemberSecretVault;
  readonly instanceId: string;
  readonly startedAt: string;
  /** serve's --ca-cert roots, for a hub on a private CA */
  readonly caCerts?: readonly string[];
  readonly teamMode: ServeTeamMode;
  /** this node's place in its team, read each time the fingerprint is */
  readonly team: () => Promise<FingerprintProps["team"]>;
  readonly liveWorkers: () => readonly FingerprintWorkerFacts[];
  readonly ready: () => boolean;
  readonly fetch?: typeof fetch;
  readonly schedule?: MemberCheckInServiceOptions["schedule"];
}

export interface ServeFederationMember {
  readonly service: MemberCheckInService;
  readonly links: HubLinkStore;
  readonly hubUrl: string;
}

/**
 * undefined, building nothing and reading nothing, unless the gate is on and
 * serve.yaml names a hub; building touches no store, vault, file or network
 */
export function buildServeFederationMember(
  deps: ServeFederationMemberDeps,
): ServeFederationMember | undefined {
  const federation = deps.merged.federation;
  if (!federationMemberEnabled(deps.env, federation)) return undefined;
  try {
    const hubUrl = federation!.hub!;
    const links = new HubLinkStore(deps.store);
    const service = new MemberCheckInService({
      hubUrl,
      ...(federation!["join-token-file"] !== undefined
        ? { joinTokenFile: federation!["join-token-file"] }
        : {}),
      instanceId: deps.instanceId,
      links,
      credentials: new MemberCredentialVault(deps.tokenSecrets),
      client: new HubClient({
        hubUrl,
        ...(deps.caCerts !== undefined ? { caCerts: deps.caCerts } : {}),
        ...(deps.fetch !== undefined ? { fetch: deps.fetch } : {}),
      }),
      fingerprint: async () =>
        await collectServeFingerprint(deps, {
          role: "member",
          team: await deps.team(),
          startedAt: deps.startedAt,
          ready: deps.ready(),
          ...memberWorkers(deps),
        }),
      ...(deps.schedule !== undefined ? { schedule: deps.schedule } : {}),
    });
    return { service, links, hubUrl };
  } catch (error) {
    logger.error(
      "Federation member not started; serve runs without it: {error}",
      { error: error instanceof Error ? error.message : String(error) },
    );
    return undefined;
  }
}

// a node of a team holds only its own workers, so a team counts the shared records every node reads alike
export function memberWorkers(
  deps: Pick<ServeFederationMemberDeps, "teamMode" | "liveWorkers">,
): { workers?: ReturnType<typeof countWorkers> } {
  if (deps.teamMode !== "local") return {};
  return { workers: countWorkers(deps.liveWorkers()) };
}
