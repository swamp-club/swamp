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

import { z } from "zod";
import type { ControlPlaneStore } from "../../domain/datastore/control_plane_store.ts";
import type { Principal } from "../../domain/access/principal.ts";
import { isServeFederationEnabled } from "../../domain/serve/federation_gate.ts";
import type { Fingerprint } from "../../domain/serve/fingerprint.ts";
import {
  type InstanceId,
  normalizedUuid,
} from "../../domain/serve/instance_id.ts";
import {
  DEFAULT_JOIN_TOKEN_DURATION_MS,
  JoinToken,
  JoinTokenError,
  joinTokenNameOf,
  type JoinTokenRecord,
} from "../../domain/serve/join_token.ts";
import { MemberCredential } from "../../domain/serve/member_credential.ts";
import { MemberName, MemberNameError } from "../../domain/serve/member_name.ts";
import { MemberRoster } from "../../domain/serve/member_roster.ts";
import {
  INSTANCE_TTL_MS,
  type MemberRole,
  type ServeMember,
  type ServeMemberRecord,
} from "../../domain/serve/serve_member.ts";
import type { FederationConfig } from "../serve_config.ts";
import { getSwampLogger } from "../../infrastructure/logging/logger.ts";
import { TransitionTail } from "../transition_tail.ts";

const logger = getSwampLogger(["serve", "federation"]);

const TOKENS_PREFIX = "federation/tokens/";
const CREDENTIALS_PREFIX = "federation/credentials/";
const SEEN_PREFIX = "federation/seen/";

/** the gate and a version 2 hub config together; nothing federation exists otherwise */
export function federationHubEnabled(
  env: (name: string) => string | undefined,
  federation: FederationConfig | undefined,
): boolean {
  return isServeFederationEnabled(env) && federation?.role === "hub";
}

export interface MemberRecords {
  list(): Promise<ServeMember[]>;
  get(name: string): Promise<ServeMember | null>;
}

export type MemberMethodCall =
  | {
    readonly method: "join";
    readonly inputs: {
      readonly memberId: string;
      readonly role: MemberRole;
      readonly fingerprint: Record<string, unknown>;
      readonly joinedAt: string;
    };
  }
  | {
    readonly method: "record";
    readonly inputs: { readonly record: ServeMemberRecord };
  }
  | {
    readonly method: "remove";
    readonly inputs: { readonly removedAt: string };
  };

/** runs a swamp/serve-member method on the definition named after the member */
export type MemberMethodRunner = (
  name: string,
  call: MemberMethodCall,
) => Promise<void>;

export interface FederationCaller {
  readonly principal: Principal | null;
  readonly sourceIp: string;
  readonly client?: string;
}

export interface FederationAdminAudit {
  tokenCreated(caller: FederationCaller, memberName: string): void;
  tokenRevoked(caller: FederationCaller, memberName: string): void;
  memberRemoved(caller: FederationCaller, memberName: string): void;
}

export interface FederationHubOptions {
  readonly store: ControlPlaneStore;
  readonly hubName: string;
  readonly members: MemberRecords;
  readonly runMemberMethod: MemberMethodRunner;
  readonly audit?: FederationAdminAudit;
  readonly now?: () => number;
}

export type FederationHubErrorCode =
  | "invalid_name"
  | "hub_name"
  | "invalid_duration"
  | "not_found"
  | "token_not_unused";

export class FederationHubError extends Error {
  constructor(readonly code: FederationHubErrorCode, message: string) {
    super(message);
    this.name = "FederationHubError";
  }
}

/** a token as listed: never its hash */
export type JoinTokenView = Omit<JoinTokenRecord, "secretHash">;

export type JoinOutcome =
  | {
    readonly kind: "joined";
    readonly memberId: string;
    readonly memberName: string;
    readonly credential: string;
  }
  | { readonly kind: "invalid-token" }
  | { readonly kind: "name-taken"; readonly memberName: string };

export type CheckInOutcome =
  | { readonly kind: "checked-in"; readonly changed: boolean }
  | { readonly kind: "unauthorized" }
  | { readonly kind: "instance-limit" };

export interface SweepReport {
  readonly membersWritten: number;
  readonly seenKeysDeleted: number;
}

const CredentialRecordSchema = z.object({
  hash: z.string().regex(/^[0-9a-f]{64}$/),
  memberName: z.string(),
}).strict();

const SeenRecordSchema = z.object({ at: z.number().int() }).strict();

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function encode(value: unknown): Uint8Array {
  return encoder.encode(JSON.stringify(value));
}

function decode(bytes: Uint8Array): unknown {
  return JSON.parse(decoder.decode(bytes));
}

function tokenKey(name: MemberName): string {
  return `${TOKENS_PREFIX}${name.value}`;
}

function memberIdSegment(memberId: string): string {
  const id = normalizedUuid(memberId);
  if (id === undefined || id !== memberId) {
    throw new Error("A member id in a control-plane key must be a UUID");
  }
  return id;
}

function credentialKey(memberId: string): string {
  return `${CREDENTIALS_PREFIX}${memberIdSegment(memberId)}`;
}

function seenKey(memberId: string, instanceId: InstanceId): string {
  return `${SEEN_PREFIX}${memberIdSegment(memberId)}/${instanceId.value}`;
}

function parseSeenKey(
  key: string,
): { memberId: string; instanceId: string } | undefined {
  if (!key.startsWith(SEEN_PREFIX)) return undefined;
  const parts = key.slice(SEEN_PREFIX.length).split("/");
  if (parts.length !== 2) return undefined;
  const memberId = normalizedUuid(parts[0]);
  const instanceId = normalizedUuid(parts[1]);
  if (memberId !== parts[0] || instanceId !== parts[1]) return undefined;
  return { memberId: memberId!, instanceId: instanceId! };
}

function memberName(input: unknown): MemberName {
  try {
    return MemberName.create(input);
  } catch (error) {
    if (error instanceof MemberNameError) {
      throw new FederationHubError("invalid_name", error.message);
    }
    throw error;
  }
}

function tokenView(token: JoinToken, now: number): JoinTokenView {
  const { secretHash: _hash, ...view } = token.toJSON();
  return { ...view, state: token.stateAt(now) };
}

/**
 * the hub's side of federation; it keeps no credential index in memory, so a
 * node that becomes leader, or a write from the local CLI, needs no refresh
 */
export class FederationHub {
  readonly #store: ControlPlaneStore;
  readonly #members: MemberRecords;
  readonly #run: MemberMethodRunner;
  readonly #audit: FederationAdminAudit | undefined;
  readonly #now: () => number;
  readonly #tail = new TransitionTail("federation");
  readonly hubName: string;

  constructor(options: FederationHubOptions) {
    this.#store = options.store;
    this.#members = options.members;
    this.#run = options.runMemberMethod;
    this.#audit = options.audit;
    this.#now = options.now ?? Date.now;
    this.hubName = MemberName.create(options.hubName).value;
  }

  settled(): Promise<void> {
    return this.#tail.settled();
  }

  async createToken(
    name: string,
    durationMs: number = DEFAULT_JOIN_TOKEN_DURATION_MS,
    caller?: FederationCaller,
  ): Promise<{ readonly token: JoinTokenView; readonly plaintext: string }> {
    const validName = memberName(name);
    if (validName.value === this.hubName) {
      throw new FederationHubError(
        "hub_name",
        `'${validName.value}' is this hub's own name; a member needs another`,
      );
    }
    const minted = await this.#tail.run("token_create", async () => {
      const now = this.#now();
      let result;
      try {
        result = JoinToken.mint(validName, durationMs, now);
      } catch (error) {
        if (error instanceof JoinTokenError) {
          throw new FederationHubError("invalid_duration", error.message);
        }
        throw error;
      }
      await this.#store.put(tokenKey(validName), encode(result.token.toJSON()));
      return {
        token: tokenView(result.token, now),
        plaintext: result.plaintext,
      };
    });
    if (caller !== undefined) {
      this.#audit?.tokenCreated(caller, validName.value);
    }
    return minted;
  }

  async listTokens(): Promise<JoinTokenView[]> {
    const now = this.#now();
    const views: JoinTokenView[] = [];
    for (const key of await this.#store.list(TOKENS_PREFIX)) {
      const name = key.slice(TOKENS_PREFIX.length);
      if (MemberName.problem(name) !== undefined) continue;
      const token = await this.#readToken(MemberName.create(name));
      if (token !== null) views.push(tokenView(token, now));
    }
    return views.sort((a, b) => a.memberName.localeCompare(b.memberName));
  }

  async revokeToken(
    name: string,
    caller?: FederationCaller,
  ): Promise<JoinTokenView> {
    const validName = memberName(name);
    const revoked = await this.#tail.run("token_revoke", async () => {
      const token = await this.#readToken(validName);
      if (token === null) {
        throw new FederationHubError(
          "not_found",
          `No join token for '${validName.value}'`,
        );
      }
      const now = this.#now();
      let next: JoinToken;
      try {
        next = token.revoke(now);
      } catch (error) {
        if (error instanceof JoinTokenError) {
          throw new FederationHubError("token_not_unused", error.message);
        }
        throw error;
      }
      await this.#store.put(tokenKey(validName), encode(next.toJSON()));
      return tokenView(next, now);
    });
    if (caller !== undefined) {
      this.#audit?.tokenRevoked(caller, validName.value);
    }
    return revoked;
  }

  async listMembers(): Promise<ServeMember[]> {
    return (await this.#members.list()).sort((a, b) =>
      a.name.localeCompare(b.name)
    );
  }

  async getMember(name: string): Promise<ServeMember | null> {
    return await this.#members.get(memberName(name).value);
  }

  /** marks the record removed, then drops the credential, so a crash between leaves a removed member */
  async removeMember(
    name: string,
    caller?: FederationCaller,
  ): Promise<ServeMember> {
    const validName = memberName(name);
    const removed = await this.#tail.run("member_remove", async () => {
      const existing = await this.#members.get(validName.value);
      if (existing === null || existing.role === "hub") {
        throw new FederationHubError(
          "not_found",
          `No member named '${validName.value}'`,
        );
      }
      const now = this.#now();
      const { member, changed } = existing.remove(now);
      if (changed) {
        await this.#run(validName.value, {
          method: "remove",
          inputs: { removedAt: new Date(now).toISOString() },
        });
      }
      await this.#store.delete(credentialKey(member.memberId));
      return member;
    });
    if (caller !== undefined) {
      this.#audit?.memberRemoved(caller, validName.value);
    }
    return removed;
  }

  /** the token is spent before anything else is written, so it is never reusable */
  join(presented: unknown, fingerprint: Fingerprint): Promise<JoinOutcome> {
    const name = joinTokenNameOf(presented);
    if (name === undefined) {
      return Promise.resolve({ kind: "invalid-token" });
    }
    return this.#tail.run("member_join", async () => {
      const now = this.#now();
      const memberId = crypto.randomUUID();
      const use = JoinToken.use(
        await this.#readToken(name),
        presented,
        memberId,
        now,
      );
      if (!use.ok) return { kind: "invalid-token" };
      const roster = new MemberRoster(
        await this.#members.list(),
        this.hubName,
      );
      if (roster.isNameTaken(name)) {
        return { kind: "name-taken", memberName: name.value };
      }
      await this.#store.put(tokenKey(name), encode(use.token.toJSON()));
      const credential = MemberCredential.issue(memberId);
      await this.#store.put(
        credentialKey(memberId),
        encode({ hash: credential.hash(), memberName: name.value }),
      );
      await this.#run(name.value, {
        method: "join",
        inputs: {
          memberId,
          role: "member",
          fingerprint: fingerprint.toJSON() as unknown as Record<
            string,
            unknown
          >,
          joinedAt: new Date(now).toISOString(),
        },
      });
      return {
        kind: "joined",
        memberId,
        memberName: name.value,
        credential: credential.toWire(),
      };
    });
  }

  async checkIn(
    credential: MemberCredential,
    instanceId: InstanceId,
    fingerprint: Fingerprint,
  ): Promise<CheckInOutcome> {
    const stored = await this.#readCredential(credential.memberId);
    if (stored === null || !credential.verify(stored.hash)) {
      return { kind: "unauthorized" };
    }
    return await this.#tail.run("member_check_in", async () => {
      const member = await this.#members.get(stored.memberName);
      if (
        member === null || member.memberId !== credential.memberId ||
        member.role !== "member"
      ) {
        return { kind: "unauthorized" };
      }
      const now = this.#now();
      const result = member.checkIn(instanceId, fingerprint, now);
      if (!result.ok) {
        return result.refusal === "removed"
          ? { kind: "unauthorized" }
          : { kind: "instance-limit" };
      }
      await this.#store.put(
        seenKey(member.memberId, instanceId),
        encode({ at: now }),
      );
      if (result.changed) {
        await this.#run(member.name, {
          method: "record",
          inputs: { record: result.member.toJSON() },
        });
      }
      return { kind: "checked-in", changed: result.changed };
    });
  }

  /** the hub's own record: written by the leader only, and only on change */
  upsertSelf(fingerprint: Fingerprint): Promise<{ changed: boolean }> {
    return this.#tail.run("hub_record", async () => {
      const existing = await this.#members.get(this.hubName);
      if (existing === null || existing.isRemoved) {
        await this.#run(this.hubName, {
          method: "join",
          inputs: {
            memberId: crypto.randomUUID(),
            role: "hub",
            fingerprint: fingerprint.toJSON() as unknown as Record<
              string,
              unknown
            >,
            joinedAt: new Date(this.#now()).toISOString(),
          },
        });
        return { changed: true };
      }
      if (existing.role !== "hub") {
        logger.warn(
          "A member holds the hub's name {name}; the hub's own record is not written",
          { name: this.hubName },
        );
        return { changed: false };
      }
      const { member, changed } = existing.withFingerprint(fingerprint);
      if (changed) {
        await this.#run(this.hubName, {
          method: "record",
          inputs: { record: member.toJSON() },
        });
      }
      return { changed };
    });
  }

  /** derives every member's status from its check-ins and drops what is past INSTANCE_TTL_MS */
  sweep(): Promise<SweepReport> {
    return this.#tail.run("member_sweep", async () => {
      const now = this.#now();
      const seenByMember = new Map<string, Map<string, number>>();
      const keysByMember = new Map<string, Map<string, string>>();
      let seenKeysDeleted = 0;
      const drop = async (key: string) => {
        await this.#store.delete(key);
        seenKeysDeleted++;
      };
      for (const key of await this.#store.list(SEEN_PREFIX)) {
        const parsed = parseSeenKey(key);
        if (parsed === undefined) continue;
        const at = await this.#readSeen(key);
        if (at === undefined || now - at >= INSTANCE_TTL_MS) {
          await drop(key);
          continue;
        }
        const seen = seenByMember.get(parsed.memberId) ?? new Map();
        seen.set(parsed.instanceId, at);
        seenByMember.set(parsed.memberId, seen);
        const keys = keysByMember.get(parsed.memberId) ?? new Map();
        keys.set(parsed.instanceId, key);
        keysByMember.set(parsed.memberId, keys);
      }
      let membersWritten = 0;
      const live = new Set<string>();
      for (const member of await this.#members.list()) {
        if (member.isRemoved || member.role !== "member") continue;
        live.add(member.memberId);
        const result = member.applySeen(
          seenByMember.get(member.memberId) ?? new Map(),
          now,
        );
        if (result.changed) {
          await this.#run(member.name, {
            method: "record",
            inputs: { record: result.member.toJSON() },
          });
          membersWritten++;
        }
        const keys = keysByMember.get(member.memberId);
        for (const instanceId of result.prunedInstanceIds) {
          const key = keys?.get(instanceId);
          if (key !== undefined) await drop(key);
        }
      }
      for (const [memberId, keys] of keysByMember) {
        if (live.has(memberId)) continue;
        for (const key of keys.values()) await drop(key);
      }
      return { membersWritten, seenKeysDeleted };
    });
  }

  async #readToken(name: MemberName): Promise<JoinToken | null> {
    const bytes = await this.#store.get(tokenKey(name));
    if (bytes === null) return null;
    try {
      return JoinToken.fromJSON(decode(bytes));
    } catch {
      logger.warn("Skipping an unreadable join token record for {name}", {
        name: name.value,
      });
      return null;
    }
  }

  async #readCredential(
    memberId: string,
  ): Promise<z.infer<typeof CredentialRecordSchema> | null> {
    const bytes = await this.#store.get(credentialKey(memberId));
    if (bytes === null) return null;
    try {
      return CredentialRecordSchema.parse(decode(bytes));
    } catch {
      return null;
    }
  }

  async #readSeen(key: string): Promise<number | undefined> {
    const bytes = await this.#store.get(key);
    if (bytes === null) return undefined;
    try {
      return SeenRecordSchema.parse(decode(bytes)).at;
    } catch {
      return undefined;
    }
  }
}
