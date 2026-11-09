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

import { integrationClient } from "../domain/access/client.ts";
import {
  accessTokenExpiry,
  accessTokenMatches,
} from "../domain/access/delegation.ts";
import type { DelegationLookup } from "../domain/access/delegation_directory.ts";
import {
  delegatedSecretKindOf,
  parseDelegatedSecret,
} from "../domain/access/delegated_token.ts";
import type { RepositoryContext } from "../infrastructure/persistence/repository_factory.ts";
import { getSwampLogger } from "../infrastructure/logging/logger.ts";

const logger = getSwampLogger(["serve", "delegated-token-auth"]);

export const DELEGATION_SESSION_PREFIX = "delegation:";

/** the session and run-binding name of a delegation, never a server token's */
export function delegationSessionName(id: string): string {
  return `${DELEGATION_SESSION_PREFIX}${id}`;
}

export function delegationOfSessionName(name: string): string | undefined {
  return name.startsWith(DELEGATION_SESSION_PREFIX)
    ? name.slice(DELEGATION_SESSION_PREFIX.length)
    : undefined;
}

// one serve per repository context; authentication finds its directory here so
// every existing call site authenticates delegated tokens without new wiring
const lookups = new WeakMap<RepositoryContext, DelegationLookup>();

export function registerDelegationLookup(
  repoContext: RepositoryContext,
  lookup: DelegationLookup,
): void {
  lookups.set(repoContext, lookup);
}

export function delegationLookupFor(
  repoContext: RepositoryContext,
): DelegationLookup | undefined {
  return lookups.get(repoContext);
}

export type DelegatedAuthResult =
  | {
    readonly ok: true;
    readonly principalId: string;
    readonly collectives: readonly string[];
    readonly groups: readonly string[];
    readonly tokenName: string;
    readonly tokenCreatedAt: string;
    readonly oauthIdentity: { email: string; username?: string };
    readonly client: string;
    readonly delegation: string;
    readonly accessExpiresAt: string;
  }
  | {
    readonly ok: false;
    readonly error: string;
    readonly reason: "invalid-format" | "revoked" | "secret-mismatch";
  };

export function isDelegatedSecret(presented: string): boolean {
  return delegatedSecretKindOf(presented) !== null;
}

/**
 * only an access token authenticates a request; a refresh or redeem secret is
 * refused before any lookup, and every refusal reads the same to the caller
 */
export async function authenticateDelegatedToken(
  presented: string,
  lookup: DelegationLookup | undefined,
  nowMs: number = Date.now(),
): Promise<DelegatedAuthResult> {
  const parsed = parseDelegatedSecret(presented);
  if (parsed === null || parsed.kind !== "access") {
    return {
      ok: false,
      error: "Authentication failed",
      reason: "invalid-format",
    };
  }
  const id = parsed.delegationId;
  const standing = lookup?.standingOf(id, nowMs) ?? { kind: "unknown" };
  const record = lookup?.recordOf(id);
  if (
    standing.kind !== "standing" || record === undefined ||
    record.person === undefined || record.consentedAt === undefined
  ) {
    logger.info("Delegated token for {id} refused ({standing})", {
      id,
      standing: standing.kind,
    });
    return { ok: false, error: "Authentication failed", reason: "revoked" };
  }
  if (!await accessTokenMatches(record, presented, nowMs)) {
    return {
      ok: false,
      error: "Authentication failed",
      reason: "secret-mismatch",
    };
  }
  const expiry = await accessTokenExpiry(record, presented);
  return {
    ok: true,
    principalId: `user:${record.person.sub}`,
    collectives: record.person.collectives,
    groups: record.person.groups,
    tokenName: delegationSessionName(id),
    // fixed for the delegation's life, so rotation never regroups its sessions
    tokenCreatedAt: record.consentedAt,
    oauthIdentity: {
      email: record.person.email,
      ...(record.person.username ? { username: record.person.username } : {}),
    },
    client: integrationClient(record.integrationId),
    delegation: id,
    accessExpiresAt: expiry ?? record.tokens!.accessExpiresAt,
  };
}
