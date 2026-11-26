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

export const JoinTokenRecordSchema = z.object({
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
}).strict();

export type JoinTokenRecord = z.infer<typeof JoinTokenRecordSchema>;

export class JoinTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JoinTokenError";
  }
}

/** missing, used, expired, revoked and a wrong secret are one refusal */
export type JoinTokenUse =
  | { readonly ok: true; readonly token: JoinToken }
  | { readonly ok: false; readonly refusal: "invalid" };

const INVALID: JoinTokenUse = { ok: false, refusal: "invalid" };

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
  /** the only time the plaintext exists outside the member */
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
    memberId: string,
    now: number,
  ): JoinTokenUse {
    if (token === null || typeof presented !== "string") return INVALID;
    const id = normalizedUuid(memberId);
    if (id === undefined) {
      throw new JoinTokenError("A joining member's id must be a UUID");
    }
    const matches = matchesHash(presented, token.record.secretHash);
    if (!matches || token.stateAt(now) !== "unused") return INVALID;
    return {
      ok: true,
      token: new JoinToken({
        ...token.record,
        state: "used",
        usedAt: new Date(now).toISOString(),
        memberId: id,
      }),
    };
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

  toJSON(): JoinTokenRecord {
    return { ...this.record };
  }
}
