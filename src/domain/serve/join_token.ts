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
import {
  isFederationSecret,
  matchesHash,
  newFederationSecret,
  sha256Hex,
} from "./federation_secret.ts";
import { normalizedUuid } from "./instance_id.ts";
import { MemberName } from "./member_name.ts";

const HOUR_MS = 60 * 60 * 1000;
export const DEFAULT_JOIN_TOKEN_DURATION_MS = HOUR_MS;
export const MAX_JOIN_TOKEN_DURATION_MS = 30 * 24 * HOUR_MS;

export const JoinTokenStateSchema = z.enum([
  "unused",
  "used",
  "expired",
  "revoked",
]);

export type JoinTokenState = z.infer<typeof JoinTokenStateSchema>;

const joinTokenFields = {
  memberName: z.string().refine((value) =>
    MemberName.problem(value) === undefined
  ),
  state: JoinTokenStateSchema,
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  usedAt: z.string().datetime().optional(),
  memberId: z.string().optional(),
  revokedAt: z.string().datetime().optional(),
  /** sha256 hex of the wire form; the plaintext is shown once and never kept */
  secretHash: z.string().regex(/^[0-9a-f]{64}$/),
  /** sha256 hex of the joinId the first join sent, so only that member can replay */
  joinIdHash: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  /** set once the member record exists, so a replay never recreates a deleted member */
  admittedAt: z.string().datetime().optional(),
};

// every hub of a team reads and rewrites it: unknown keys are read past and kept
export const JoinTokenRecordSchema = z.looseObject(joinTokenFields);

const JoinTokenRecordFields = z.strictObject(joinTokenFields);

export type JoinTokenRecord = z.infer<typeof JoinTokenRecordFields>;

/** a token as listed: never a hash */
export type JoinTokenView = Omit<JoinTokenRecord, "secretHash" | "joinIdHash">;

const VIEW_FIELDS = [
  "memberName",
  "state",
  "createdAt",
  "expiresAt",
  "usedAt",
  "memberId",
  "revokedAt",
  "admittedAt",
] as const satisfies readonly (keyof JoinTokenView)[];

export class JoinTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JoinTokenError";
  }
}

/**
 * a replay is the first join again, carrying the same token and joinId before
 * expiry; every other refusal (missing, used, expired, revoked, a wrong secret
 * or joinId) is one shape
 */
export type JoinTokenUse =
  | { readonly kind: "first-use"; readonly token: JoinToken }
  | {
    readonly kind: "replay";
    readonly memberId: string;
    /** the member record was written; a replay that finds none must not recreate it */
    readonly admitted: boolean;
  }
  | { readonly kind: "refused" };

const REFUSED: JoinTokenUse = { kind: "refused" };

/** the joinId a join carries: a UUID, in lower case only */
export function joinIdOf(value: unknown): string | undefined {
  const id = normalizedUuid(value);
  return id !== undefined && id === value ? id : undefined;
}

/** the name a presented <name>.<secret> claims, so its record can be found */
export function joinTokenNameOf(wire: unknown): MemberName | undefined {
  if (typeof wire !== "string") return undefined;
  const dot = wire.indexOf(".");
  if (dot < 0) return undefined;
  const name = wire.slice(0, dot);
  if (MemberName.problem(name) !== undefined) return undefined;
  if (!isFederationSecret(wire.slice(dot + 1))) return undefined;
  return MemberName.create(name);
}

export interface MintedJoinToken {
  readonly token: JoinToken;
  /** the one copy handed out; the hub keeps only its hash */
  readonly plaintext: string;
}

/** single use: unused → used | expired | revoked, each terminal */
export class JoinToken {
  private constructor(private readonly record: JoinTokenRecord) {}

  static mint(
    name: MemberName,
    durationMs: number,
    now: number,
  ): MintedJoinToken {
    if (
      !Number.isInteger(durationMs) || durationMs <= 0 ||
      durationMs > MAX_JOIN_TOKEN_DURATION_MS
    ) {
      throw new JoinTokenError(
        "A join token lasts between 1 millisecond and 30 days",
      );
    }
    const plaintext = `${name.value}.${newFederationSecret()}`;
    const token = new JoinToken({
      memberName: name.value,
      state: "unused",
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + durationMs).toISOString(),
      secretHash: sha256Hex(plaintext),
    });
    return { token, plaintext };
  }

  static fromJSON(json: unknown): JoinToken {
    return new JoinToken(JoinTokenRecordSchema.parse(json));
  }

  /** the token half of a join; a null token reads the same as a bad one */
  static use(
    token: JoinToken | null,
    presented: unknown,
    joinId: string,
    memberId: string,
    now: number,
  ): JoinTokenUse {
    if (joinIdOf(joinId) === undefined) {
      throw new JoinTokenError("A join's joinId must be a lower-case UUID");
    }
    const id = normalizedUuid(memberId);
    if (id === undefined) {
      throw new JoinTokenError("A joining member's id must be a UUID");
    }
    if (token === null || typeof presented !== "string") return REFUSED;
    if (!matchesHash(presented, token.record.secretHash)) return REFUSED;
    const state = token.stateAt(now);
    if (state === "unused") {
      return {
        kind: "first-use",
        token: new JoinToken({
          ...token.record,
          state: "used",
          usedAt: new Date(now).toISOString(),
          memberId: id,
          joinIdHash: sha256Hex(joinId),
        }),
      };
    }
    const { joinIdHash, memberId: usedBy } = token.record;
    if (
      state === "used" && joinIdHash !== undefined && usedBy !== undefined &&
      now < Date.parse(token.expiresAt) && matchesHash(joinId, joinIdHash)
    ) {
      return {
        kind: "replay",
        memberId: usedBy,
        admitted: token.record.admittedAt !== undefined,
      };
    }
    return REFUSED;
  }

  get memberName(): string {
    return this.record.memberName;
  }

  get memberId(): string | undefined {
    return this.record.memberId;
  }

  get state(): JoinTokenState {
    return this.record.state;
  }

  get expiresAt(): string {
    return this.record.expiresAt;
  }

  /** an unused token past its expiry reads as expired before anything records it */
  stateAt(now: number): JoinTokenState {
    if (this.record.state === "unused" && now >= Date.parse(this.expiresAt)) {
      return "expired";
    }
    return this.record.state;
  }

  revoke(now: number): JoinToken {
    if (this.stateAt(now) !== "unused") {
      throw new JoinTokenError(
        `Join token for '${this.memberName}' is ${
          this.stateAt(now)
        }; only an unused token can be revoked`,
      );
    }
    return new JoinToken({
      ...this.record,
      state: "revoked",
      revokedAt: new Date(now).toISOString(),
    });
  }

  /** the expired record, or undefined while nothing needs writing */
  expire(now: number): JoinToken | undefined {
    if (this.record.state !== "unused" || this.stateAt(now) !== "expired") {
      return undefined;
    }
    return new JoinToken({ ...this.record, state: "expired" });
  }

  /** once the member record is written; idempotent */
  admit(now: number): JoinToken {
    if (this.record.state !== "used") {
      throw new JoinTokenError(
        `Join token for '${this.memberName}' is ${this.record.state}; only a used token admits a member`,
      );
    }
    if (this.record.admittedAt !== undefined) return this;
    return new JoinToken({
      ...this.record,
      admittedAt: new Date(now).toISOString(),
    });
  }

  get admittedAt(): string | undefined {
    return this.record.admittedAt;
  }

  /** what a listing shows: the known fields only, never a hash or a newer hub's field */
  view(now: number): JoinTokenView {
    const view: Record<string, unknown> = {};
    for (const key of VIEW_FIELDS) {
      if (this.record[key] !== undefined) view[key] = this.record[key];
    }
    return { ...view, state: this.stateAt(now) } as JoinTokenView;
  }

  toJSON(): JoinTokenRecord {
    return { ...this.record };
  }
}
