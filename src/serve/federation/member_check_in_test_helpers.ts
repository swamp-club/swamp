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
import { Fingerprint } from "../../domain/serve/fingerprint.ts";
import { MemberCredential } from "../../domain/serve/member_credential.ts";
import { ControlPlaneVaultProvider } from "../../domain/vaults/control_plane_vault_provider.ts";
import type { CheckInReply, HubOutcome, JoinReply } from "./hub_client.ts";
import { HubLinkStore } from "./hub_link_store.ts";
import {
  MemberCheckInService,
  type MemberCheckInServiceOptions,
} from "./member_check_in_service.ts";
import { MemberCredentialVault } from "./member_credential_vault.ts";

export const TEST_HUB_URL = "https://hub.example.com";
export const TEST_FINGERPRINT = Fingerprint.create({
  swampVersion: "20261125.1629.0",
  platform: "linux",
  arch: "x86_64",
  serveYamlVersion: 2,
  deploymentMode: "local",
  datastoreKind: "filesystem",
  datastoreFormat: "v2",
  vaultKinds: [],
  authMode: "token",
  tls: false,
  remoteOnly: false,
  loopbackOnly: true,
  federationRole: "member",
  extensions: [],
  settingsHash: "0".repeat(64),
  workers: { total: 0, byVersion: {}, byLabelKey: {} },
  team: { role: "single", nodes: 1 },
  startedAt: "2026-11-26T12:00:00.000Z",
  ready: true,
});

/** a control-plane store whose putIfAbsent is atomic, as a real one's is */
export class AtomicMemoryStore implements ControlPlaneStore {
  readonly entries = new Map<string, Uint8Array>();

  put(key: string, data: Uint8Array): Promise<void> {
    this.entries.set(key, data);
    return Promise.resolve();
  }

  putIfAbsent(key: string, data: Uint8Array): Promise<boolean> {
    if (this.entries.has(key)) return Promise.resolve(false);
    this.entries.set(key, data);
    return Promise.resolve(true);
  }

  get(key: string): Promise<Uint8Array | null> {
    return Promise.resolve(this.entries.get(key) ?? null);
  }

  delete(key: string): Promise<void> {
    this.entries.delete(key);
    return Promise.resolve();
  }

  list(prefix: string): Promise<string[]> {
    return Promise.resolve(
      [...this.entries.keys()].filter((key) => key.startsWith(prefix)).sort(),
    );
  }
}

/** a hub that issues credentials and refuses removed members; any call may be scripted */
export class FakeHub {
  readonly tokens = new Set<string>();
  readonly removed = new Set<string>();
  readonly joins: string[] = [];
  readonly joinIds: string[] = [];
  /** joins the hub accepts, then answers as if the reply were lost */
  dropReplies = 0;
  readonly #spent = new Map<string, { joinId: string; memberId: string }>();
  readonly checkIns: { memberId: string; instanceId: string }[] = [];
  readonly scriptedJoins: HubOutcome<JoinReply>[] = [];
  readonly scriptedCheckIns: HubOutcome<CheckInReply>[] = [];
  /** runs inside a join before the hub answers it */
  beforeJoin: (() => void) | undefined;
  /** runs inside a check-in before the hub answers it */
  beforeCheckIn: (() => Promise<void>) | undefined;
  intervalSeconds = 30;
  hubName = "central";
  disposed = 0;
  /** as the real hub does: each join issues a credential that replaces the last */
  rotateCredentials = false;
  readonly #current = new Map<string, string>();

  mintToken(): string {
    const token = `edge.${crypto.randomUUID()}`;
    this.tokens.add(token);
    return token;
  }

  client(): MemberCheckInServiceOptions["client"] {
    return {
      join: (token, joinId) => {
        const hook = this.beforeJoin;
        this.beforeJoin = undefined;
        hook?.();
        return Promise.resolve(this.#join(token, joinId));
      },
      checkIn: async (credential, instanceId) => {
        const hook = this.beforeCheckIn;
        this.beforeCheckIn = undefined;
        await hook?.();
        return this.#checkIn(credential, instanceId);
      },
      dispose: () => {
        this.disposed++;
      },
    };
  }

  #join(token: string, joinId: string): HubOutcome<JoinReply> {
    this.joins.push(token);
    this.joinIds.push(joinId);
    const scripted = this.scriptedJoins.shift();
    if (scripted !== undefined) return scripted;
    const spent = this.#spent.get(token);
    let memberId: string;
    if (this.tokens.delete(token)) {
      memberId = crypto.randomUUID();
      this.#spent.set(token, { joinId, memberId });
    } else if (
      spent !== undefined && spent.joinId === joinId &&
      !this.removed.has(spent.memberId)
    ) {
      memberId = spent.memberId;
    } else {
      return { kind: "unauthorized" };
    }
    const credential = MemberCredential.issue(memberId);
    this.#current.set(memberId, credential.toWire());
    if (this.dropReplies > 0) {
      this.dropReplies--;
      return { kind: "unreachable" };
    }
    return {
      kind: "ok",
      value: {
        memberId,
        memberName: "edge",
        credential,
        hub: this.#identity(),
        checkInIntervalSeconds: this.intervalSeconds,
      },
    };
  }

  #checkIn(
    credential: MemberCredential,
    instanceId: string,
  ): HubOutcome<CheckInReply> {
    const scripted = this.scriptedCheckIns.shift();
    if (scripted !== undefined) return scripted;
    if (this.removed.has(credential.memberId)) return { kind: "unauthorized" };
    if (
      this.rotateCredentials &&
      this.#current.get(credential.memberId) !== credential.toWire()
    ) {
      return { kind: "unauthorized" };
    }
    this.checkIns.push({ memberId: credential.memberId, instanceId });
    return {
      kind: "ok",
      value: {
        hub: this.#identity(),
        checkInIntervalSeconds: this.intervalSeconds,
      },
    };
  }

  #identity() {
    return { name: this.hubName, swampVersion: "1.0.0", protocolVersion: 1 };
  }
}

export interface MemberNode {
  readonly service: MemberCheckInService;
  readonly instanceId: string;
  readonly links: HubLinkStore;
  readonly credentials: MemberCredentialVault;
}

/** one serve process's member service over a shared store */
export async function memberNode(
  store: AtomicMemoryStore,
  hub: FakeHub,
  options: {
    readonly token?: string;
    readonly hubUrl?: string;
    readonly instanceId?: string;
  } = {},
): Promise<MemberNode> {
  const provider = new ControlPlaneVaultProvider(store, { migrate: false });
  await provider.initialize();
  const links = new HubLinkStore(store);
  const credentials = new MemberCredentialVault(provider);
  const instanceId = options.instanceId ?? crypto.randomUUID();
  const service = new MemberCheckInService({
    hubUrl: options.hubUrl ?? TEST_HUB_URL,
    ...(options.token !== undefined ? { joinTokenFile: "join-token.txt" } : {}),
    instanceId,
    links,
    credentials,
    client: hub.client(),
    fingerprint: () => Promise.resolve(TEST_FINGERPRINT),
    readJoinToken: () => Promise.resolve(options.token),
    schedule: {
      intervalBounds: { minSeconds: 0.005, maxSeconds: 3600 },
      maxBackoffMs: 40,
      livenessMs: 5,
      joinWaitMs: 5,
      random: () => 0.5,
    },
  });
  return { service, instanceId, links, credentials };
}
