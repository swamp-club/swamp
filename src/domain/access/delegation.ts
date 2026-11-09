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

import type {
  DelegationRecord,
  ExternalIdentity,
  LinkedPerson,
} from "../models/access/delegation_model.ts";
import { Ceiling } from "./ceiling.ts";
import { issueDelegatedSecret, type IssuedSecret } from "./delegated_token.ts";
import { delegatedSecretMatches } from "./delegated_token.ts";

export const DELEGATION_MAX_LIFE_MS = 30 * 24 * 60 * 60 * 1000;
export const DELEGATED_ACCESS_LIFE_MS = 60 * 60 * 1000;
/** a consented link the app never redeems is ended, so swamp-club stops showing it */
export const DELEGATION_REDEEM_WINDOW_MS = 60 * 60 * 1000;

export class DelegationTransitionError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "DelegationTransitionError";
  }
}

function iso(nowMs: number): string {
  return new Date(nowMs).toISOString();
}

/** ids from chat platforms differ in case and stray whitespace between calls */
export function canonicalExternalKey(
  integrationId: string,
  external: Pick<ExternalIdentity, "platform" | "teamId" | "userId">,
): string {
  return JSON.stringify([
    integrationId,
    external.platform.trim().toLowerCase(),
    external.teamId.trim().toLowerCase(),
    external.userId.trim().toLowerCase(),
  ]);
}

export interface StartDelegationInput {
  readonly id: string;
  readonly integrationId: string;
  readonly external: ExternalIdentity;
  readonly ceiling: Ceiling;
  readonly ceilingDigest: string;
  readonly redeemHash: string;
  readonly requestId: string;
  readonly digest: string;
  readonly consentExpiresAt: string;
  readonly pollIntervalSeconds: number;
}

export function startDelegation(
  input: StartDelegationInput,
  nowMs: number,
): DelegationRecord {
  return {
    id: input.id,
    integrationId: input.integrationId,
    external: {
      ...input.external,
      platform: input.external.platform.trim().toLowerCase(),
      teamId: input.external.teamId.trim(),
      userId: input.external.userId.trim(),
    },
    ceiling: input.ceiling.toDocument(),
    ceilingDigest: input.ceilingDigest,
    phase: "awaiting_consent",
    createdAt: iso(nowMs),
    updatedAt: iso(nowMs),
    redeemHash: input.redeemHash,
    club: {
      requestId: input.requestId,
      digest: input.digest,
      consentExpiresAt: input.consentExpiresAt,
      pollIntervalSeconds: input.pollIntervalSeconds,
      endState: "none",
      endAttempts: 0,
    },
  };
}

function requirePhase(
  record: DelegationRecord,
  phases: readonly DelegationRecord["phase"][],
  action: string,
): void {
  if (!phases.includes(record.phase)) {
    throw new DelegationTransitionError(
      "wrong_phase",
      `Delegation ${record.id} is ${record.phase}, so it can't ${action}`,
    );
  }
}

/** the person is written here because swamp-club stops returning it once reported */
export function recordApproval(
  record: DelegationRecord,
  person: LinkedPerson,
  nowMs: number,
): DelegationRecord {
  requirePhase(record, ["awaiting_consent"], "record an approval");
  return { ...record, phase: "reporting", person, updatedAt: iso(nowMs) };
}

/** the life is fixed from consent and never extended */
export function recordReported(
  record: DelegationRecord,
  linkId: string,
  nowMs: number,
): DelegationRecord {
  requirePhase(record, ["reporting"], "be recorded");
  return {
    ...record,
    phase: "consented",
    club: { ...record.club, linkId },
    consentedAt: iso(nowMs),
    expiresAt: iso(nowMs + DELEGATION_MAX_LIFE_MS),
    updatedAt: iso(nowMs),
  };
}

export function refuseDelegation(
  record: DelegationRecord,
  reason: string,
  nowMs: number,
): DelegationRecord {
  requirePhase(record, ["awaiting_consent", "reporting"], "be refused");
  return {
    ...record,
    phase: "refused",
    refusal: { reason: reason.slice(0, 500), at: iso(nowMs) },
    updatedAt: iso(nowMs),
  };
}

export interface IssuedTokens {
  readonly access: IssuedSecret;
  readonly refresh: IssuedSecret;
  readonly accessExpiresAt: string;
}

async function newTokens(id: string, nowMs: number): Promise<IssuedTokens> {
  return {
    access: await issueDelegatedSecret("access", id),
    refresh: await issueDelegatedSecret("refresh", id),
    accessExpiresAt: iso(
      nowMs + DELEGATED_ACCESS_LIFE_MS,
    ),
  };
}

function cappedExpiry(record: DelegationRecord, accessExpiresAt: string) {
  return record.expiresAt !== undefined && record.expiresAt < accessExpiresAt
    ? record.expiresAt
    : accessExpiresAt;
}

/** once: the phase moves past consented in the same write that stores the hashes */
export async function issueDelegationTokens(
  record: DelegationRecord,
  nowMs: number,
): Promise<{ record: DelegationRecord; tokens: IssuedTokens }> {
  requirePhase(record, ["consented"], "issue tokens");
  const tokens = await newTokens(record.id, nowMs);
  const accessExpiresAt = cappedExpiry(record, tokens.accessExpiresAt);
  return {
    tokens: { ...tokens, accessExpiresAt },
    record: {
      ...record,
      phase: "issued",
      tokens: {
        accessHash: tokens.access.hash,
        accessExpiresAt,
        refreshHash: tokens.refresh.hash,
        generation: 1,
      },
      updatedAt: iso(nowMs),
    },
  };
}

export type RefreshOutcome =
  | {
    readonly kind: "refreshed";
    readonly record: DelegationRecord;
    readonly access: IssuedSecret;
    readonly accessExpiresAt: string;
  }
  | { readonly kind: "refused"; readonly reason: RefreshRefusalReason };

export const REFRESH_REFUSAL_REASONS = [
  "mismatch",
  "unknown",
  "not_issued",
  "not_admitted",
  "ended",
  "expired",
  "superseded",
  "unreadable",
] as const satisfies readonly (
  | "mismatch"
  | "not_admitted"
  | Exclude<DelegationStanding["kind"], "standing">
)[];

export type RefreshRefusalReason = typeof REFRESH_REFUSAL_REASONS[number];

/**
 * the refresh token is kept for the delegation's life and needs the
 * integration's credential, so a racing or repeated refresh is harmless and a
 * wrong one is refused without ending anything
 */
export async function refreshDelegation(
  record: DelegationRecord,
  presentedRefresh: string,
  nowMs: number,
  standing: DelegationStanding,
): Promise<RefreshOutcome> {
  if (record.phase !== "issued" || record.tokens === undefined) {
    return { kind: "refused", reason: "not_issued" };
  }
  if (
    !await delegatedSecretMatches(presentedRefresh, record.tokens.refreshHash)
  ) {
    return { kind: "refused", reason: "mismatch" };
  }
  if (standing.kind !== "standing") {
    return { kind: "refused", reason: standing.kind };
  }
  const access = await issueDelegatedSecret("access", record.id);
  const accessExpiresAt = cappedExpiry(
    record,
    iso(nowMs + DELEGATED_ACCESS_LIFE_MS),
  );
  const current = record.tokens;
  const older = current.previousAccessHash !== undefined &&
      current.previousAccessExpiresAt !== undefined &&
      Date.parse(current.previousAccessExpiresAt) > nowMs
    ? [{
      hash: current.previousAccessHash,
      expiresAt: current.previousAccessExpiresAt,
    }]
    : undefined;
  return {
    kind: "refreshed",
    access,
    accessExpiresAt,
    record: {
      ...record,
      tokens: {
        accessHash: access.hash,
        accessExpiresAt,
        previousAccessHash: current.accessHash,
        previousAccessExpiresAt: current.accessExpiresAt,
        ...(older !== undefined ? { olderAccess: older } : {}),
        refreshHash: current.refreshHash,
        generation: current.generation + 1,
      },
      updatedAt: iso(nowMs),
    },
  };
}

/** causes swamp-club already knows need no end call back to it */
const CLUB_ORIGINATED = new Set(["club_ended"]);

export function endDelegation(
  record: DelegationRecord,
  cause: string,
  nowMs: number,
): DelegationRecord {
  if (record.phase === "ended" || record.phase === "refused") return record;
  const tellClub = record.club.linkId !== undefined &&
    !CLUB_ORIGINATED.has(cause);
  return {
    ...record,
    phase: "ended",
    ended: { cause, at: iso(nowMs) },
    tokens: undefined,
    club: {
      ...record.club,
      endState: tellClub ? "pending" : record.club.endState,
      ...(tellClub ? { nextEndAttemptAt: iso(nowMs) } : {}),
    },
    updatedAt: iso(nowMs),
  };
}

export function recordClubEnd(
  record: DelegationRecord,
  outcome: { ok: true } | { ok: false; error: string; retryAtMs: number },
  nowMs: number,
): DelegationRecord {
  if (record.club.endState !== "pending") return record;
  if (outcome.ok) {
    const { nextEndAttemptAt: _a, lastEndError: _e, ...club } = record.club;
    return {
      ...record,
      club: { ...club, endState: "done", endAttempts: club.endAttempts + 1 },
      updatedAt: iso(nowMs),
    };
  }
  return {
    ...record,
    club: {
      ...record.club,
      endAttempts: record.club.endAttempts + 1,
      lastEndError: outcome.error.slice(0, 500),
      nextEndAttemptAt: iso(outcome.retryAtMs),
    },
    updatedAt: iso(nowMs),
  };
}

export type DelegationStanding =
  | { readonly kind: "standing"; readonly ceiling: Ceiling }
  | {
    readonly kind:
      | "unknown"
      | "not_issued"
      | "ended"
      | "expired"
      | "superseded"
      | "unreadable";
  };

/**
 * the one rule for whether a delegation may act: issued, inside its life, not
 * superseded by a newer consent for the same person, with a ceiling this build
 * reads
 */
export function delegationStanding(
  record: DelegationRecord | undefined,
  nowMs: number,
  supersededBy: string | undefined,
): DelegationStanding {
  if (record === undefined) return { kind: "unknown" };
  if (record.phase === "ended" || record.phase === "refused") {
    return { kind: "ended" };
  }
  if (record.phase !== "issued" || record.tokens === undefined) {
    return { kind: "not_issued" };
  }
  if (record.expiresAt === undefined || Date.parse(record.expiresAt) <= nowMs) {
    return { kind: "expired" };
  }
  if (supersededBy !== undefined) return { kind: "superseded" };
  try {
    return { kind: "standing", ceiling: Ceiling.parse(record.ceiling) };
  } catch {
    return { kind: "unreadable" };
  }
}

/** the newest access token first, the legacy fields before olderAccess */
function accessSlots(
  tokens: NonNullable<DelegationRecord["tokens"]>,
): { hash: string; expiresAt: string }[] {
  const slots = [{
    hash: tokens.accessHash,
    expiresAt: tokens.accessExpiresAt,
  }];
  if (
    tokens.previousAccessHash !== undefined &&
    tokens.previousAccessExpiresAt !== undefined
  ) {
    slots.push({
      hash: tokens.previousAccessHash,
      expiresAt: tokens.previousAccessExpiresAt,
    });
  }
  return [...slots, ...(tokens.olderAccess ?? [])];
}

/** the current access token, or one of the two before it until each expires */
export async function accessTokenMatches(
  record: DelegationRecord,
  presented: string,
  nowMs: number,
): Promise<boolean> {
  if (record.tokens === undefined) return false;
  for (const slot of accessSlots(record.tokens)) {
    if (
      Date.parse(slot.expiresAt) > nowMs &&
      await delegatedSecretMatches(presented, slot.hash)
    ) return true;
  }
  return false;
}

/** the expiry of whichever access token matched, for closing its socket */
export async function accessTokenExpiry(
  record: DelegationRecord,
  presented: string,
): Promise<string | undefined> {
  if (record.tokens === undefined) return undefined;
  for (const slot of accessSlots(record.tokens)) {
    if (await delegatedSecretMatches(presented, slot.hash)) {
      return slot.expiresAt;
    }
  }
  return undefined;
}

/**
 * the newest consent per person supersedes every older one whatever its own
 * phase, so ending or removing the newest never brings an older one back
 */
export function supersessionOf(
  records: readonly DelegationRecord[],
): Map<string, string> {
  const newest = new Map<string, DelegationRecord>();
  for (const record of records) {
    if (record.consentedAt === undefined) continue;
    const key = canonicalExternalKey(record.integrationId, record.external);
    const seen = newest.get(key);
    if (
      seen === undefined || record.consentedAt > seen.consentedAt! ||
      (record.consentedAt === seen.consentedAt! && record.id > seen.id)
    ) newest.set(key, record);
  }
  const superseded = new Map<string, string>();
  for (const record of records) {
    if (record.consentedAt === undefined) continue;
    const winner = newest.get(
      canonicalExternalKey(record.integrationId, record.external),
    )!;
    if (winner.id !== record.id) superseded.set(record.id, winner.id);
  }
  return superseded;
}
