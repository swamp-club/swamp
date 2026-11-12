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

/**
 * one instance per token; plaintext lives only in a vault. The datastore has no
 * compare-and-swap, so the orchestrator, sole writer, serializes all token
 * transitions in memory to make them atomic.
 */

import { z } from "zod";
import { ModelType } from "../model_type.ts";
import {
  defineModel,
  type MethodContext,
  type MethodResult,
  type ModelDefinition,
} from "../model.ts";
import { generateOpaqueToken } from "../../remote/session_credential.ts";
import { timingSafeEqual } from "../../crypto/timing_safe_equal.ts";

export const ENROLLMENT_TOKEN_MODEL_TYPE = ModelType.create(
  "swamp/enrollment-token",
);

export const TokenStateSchema = z.enum([
  "unused",
  "enrolled",
  "expired",
  "revoked",
]);

export type TokenState = z.infer<typeof TokenStateSchema>;

export const MaxEnrollmentsSchema = z.union([
  z.number().int().positive(),
  z.literal("unlimited"),
]);

export type MaxEnrollments = z.infer<typeof MaxEnrollmentsSchema>;

const BindingSchema = z.object({
  machineId: z.string(),
  enrolledAt: z.string().datetime(),
  /** createdAt of the mint this machine last redeemed; absent means the current one */
  mint: z.string().datetime().optional(),
});

export type Binding = z.infer<typeof BindingSchema>;

/** the mint a rotation replaced, redeemable until its own expiresAt */
const PredecessorSchema = z.object({
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  secretKey: z.string(),
});

export type TokenPredecessor = z.infer<typeof PredecessorSchema>;

export const EnrollmentTokenSchema = z.object({
  name: z.string().describe("Token name; the worker's pool-addressable handle"),
  state: TokenStateSchema,
  createdAt: z.string().datetime(),
  /** Bounds both the enrollment window and the reconnection window. */
  expiresAt: z.string().datetime(),
  /** Vault reference to the token plaintext — never the secret itself. */
  vaultName: z.string(),
  secretKey: z.string(),
  maxEnrollments: MaxEnrollmentsSchema.default(1),
  bindings: z.array(BindingSchema).default([]),
  predecessor: PredecessorSchema.optional(),
  /** @deprecated Legacy field — kept so Zod parses old records. */
  boundMachineId: z.string().optional(),
  enrolledAt: z.string().datetime().optional(),
  revokedAt: z.string().datetime().optional(),
}).transform((token) => {
  const { boundMachineId, enrolledAt, ...rest } = token;
  if (boundMachineId && rest.bindings.length === 0) {
    return {
      ...rest,
      bindings: [{
        machineId: boundMachineId,
        enrolledAt: enrolledAt ?? rest.createdAt,
      }],
    };
  }
  return rest;
});

export type EnrollmentToken = z.output<typeof EnrollmentTokenSchema>;

const TOKEN_DATA_NAME = "token-main";

export const WORKER_TOKEN_SECRET_KEY_PREFIX = "worker-token-";

export function tokenSecretKey(tokenName: string): string {
  return `${WORKER_TOKEN_SECRET_KEY_PREFIX}${tokenName}`;
}

export const WORKER_ROTATED_TOKEN_SECRET_KEY_PREFIX = "worker-rotated-token-";

/**
 * a fresh key per rotation, so the live secret is never overwritten before the
 * record points elsewhere; its own prefix and no dot, which cloud vaults refuse
 */
export function rotatedTokenSecretKey(
  tokenName: string,
  createdAtMs: number,
): string {
  return `${WORKER_ROTATED_TOKEN_SECRET_KEY_PREFIX}${tokenName}-${createdAtMs}`;
}

async function readToken(context: MethodContext): Promise<EnrollmentToken> {
  const raw = await context.readResource!(TOKEN_DATA_NAME);
  if (raw === null) {
    throw new Error(
      `Enrollment token '${context.definition.name}' does not exist — mint it first`,
    );
  }
  return EnrollmentTokenSchema.parse(raw);
}

function isExpired(token: EnrollmentToken, nowMs: number): boolean {
  return Date.parse(token.expiresAt) <= nowMs;
}

function sameInstant(a: string, b: string): boolean {
  return Date.parse(a) === Date.parse(b);
}

function livePredecessor(
  token: EnrollmentToken,
  nowMs: number,
): TokenPredecessor | undefined {
  const predecessor = token.predecessor;
  if (predecessor === undefined) return undefined;
  return Date.parse(predecessor.expiresAt) > nowMs ? predecessor : undefined;
}

export interface EnrollmentMint {
  readonly createdAt: string;
  readonly expiresAt: string;
}

/** the mint a bound machine last redeemed, and the deadline that mint carries */
export function enrollmentMintFor(
  token: EnrollmentToken,
  machineId: string,
): EnrollmentMint {
  const binding = token.bindings.find((b) => b.machineId === machineId);
  const predecessor = token.predecessor;
  if (
    binding?.mint !== undefined && predecessor !== undefined &&
    sameInstant(binding.mint, predecessor.createdAt)
  ) {
    return {
      createdAt: predecessor.createdAt,
      expiresAt: predecessor.expiresAt,
    };
  }
  return { createdAt: token.createdAt, expiresAt: token.expiresAt };
}

async function deleteSecretBestEffort(
  context: MethodContext,
  vaultName: string,
  secretKey: string,
): Promise<void> {
  const vaultService = context.vaultService;
  try {
    if (vaultService?.supportsDelete(vaultName)) {
      await vaultService.delete(
        vaultName,
        secretKey,
        "model:enrollment-token-retire",
      );
    }
  } catch (error) {
    context.logger.warn(
      "Could not delete retired enrollment token secret {secretKey}: {error}",
      {
        secretKey,
        error: error instanceof Error ? error.message : String(error),
      },
    );
  }
}

export type EnrollmentBindingCutoffCause =
  | "revoked"
  | "reminted"
  | "deleted"
  | "expired";

export type EnrollmentBindingVerdict =
  | { readonly keep: true }
  | { readonly keep: false; readonly cause: EnrollmentBindingCutoffCause };

/**
 * whether a worker enrolled on this mint may stay connected. Minting after a
 * revoke reuses the name, so a newer createdAt is a different credential. Only
 * a rotation's predecessor expires here; the gateway times the current mint.
 */
export function enrollmentTokenBindingVerdict(
  token: EnrollmentToken | null,
  boundCreatedAt: string,
  nowMs: number = Date.now(),
): EnrollmentBindingVerdict {
  if (token === null) {
    return { keep: false, cause: "deleted" };
  }
  if (token.state === "revoked") {
    return { keep: false, cause: "revoked" };
  }
  if (
    token.predecessor !== undefined &&
    sameInstant(token.predecessor.createdAt, boundCreatedAt)
  ) {
    return Date.parse(token.predecessor.expiresAt) > nowMs
      ? { keep: true }
      : { keep: false, cause: "expired" };
  }
  // Only a newer mint is a re-mint; an older record is a stale read of the
  // mint the worker holds, never a reason to cut it off.
  if (Date.parse(token.createdAt) > Date.parse(boundCreatedAt)) {
    return { keep: false, cause: "reminted" };
  }
  return { keep: true };
}

const MintArgsSchema = z.object({
  durationMs: z.number().int().positive().describe(
    "Token lifetime in milliseconds",
  ),
  vaultName: z.string().min(1).describe(
    "Vault that stores the token plaintext",
  ),
  maxEnrollments: MaxEnrollmentsSchema.default(1),
});

async function mint(
  args: z.infer<typeof MintArgsSchema>,
  context: MethodContext,
): Promise<MethodResult> {
  if (!context.vaultService) {
    throw new Error("Minting an enrollment token requires a vault service");
  }
  const existing = await context.readResource!(TOKEN_DATA_NAME);
  let previous: EnrollmentToken | undefined;
  if (existing !== null) {
    previous = EnrollmentTokenSchema.parse(existing);
    if (
      previous.state !== "revoked" && previous.state !== "expired" &&
      !isExpired(previous, Date.now())
    ) {
      throw new Error(
        `Enrollment token '${context.definition.name}' already exists — revoke it or wait for expiry before re-minting`,
      );
    }
  }

  const name = context.definition.name;
  const secretKey = tokenSecretKey(name);
  const plaintext = generateOpaqueToken();
  await context.vaultService.put(args.vaultName, secretKey, plaintext);

  const now = Date.now();
  const token = {
    name,
    state: "unused" as const,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + args.durationMs).toISOString(),
    vaultName: args.vaultName,
    secretKey,
    maxEnrollments: args.maxEnrollments,
    bindings: [] as Binding[],
  };
  const handle = await context.writeResource!("token", TOKEN_DATA_NAME, token);
  // a rotated token's keys are per mint, so a re-mint leaves them behind
  if (previous !== undefined) {
    for (
      const retired of [previous.secretKey, previous.predecessor?.secretKey]
    ) {
      if (retired !== undefined && retired !== secretKey) {
        await deleteSecretBestEffort(context, previous.vaultName, retired);
      }
    }
  }
  return { dataHandles: [handle] };
}

const RedeemArgsSchema = z.object({
  presentedToken: z.string().min(1),
  machineId: z.string().min(1),
});

/**
 * redeems at enrollment or re-authenticates a bound machine; a re-auth writes
 * only when the machine moves between a rotation's mints, and past expiresAt
 * every machine is rejected (hard deadline). Every failure throws.
 */
async function redeem(
  args: z.infer<typeof RedeemArgsSchema>,
  context: MethodContext,
): Promise<MethodResult> {
  if (!context.vaultService) {
    throw new Error("Redeeming an enrollment token requires a vault service");
  }
  const token = await readToken(context);
  const name = context.definition.name;

  if (token.state === "revoked") {
    throw new Error(`Enrollment token '${name}' has been revoked`);
  }
  if (token.state === "expired" || isExpired(token, Date.now())) {
    throw new Error(`Enrollment token '${name}' has expired`);
  }

  const secret = await context.vaultService.get(
    token.vaultName,
    token.secretKey,
    "model:enrollment-token-verify",
  );
  const matchesCurrent = timingSafeEqual(secret, args.presentedToken);
  const predecessor = livePredecessor(token, Date.now());
  let matchesPredecessor = false;
  if (!matchesCurrent && predecessor !== undefined) {
    // a key a concurrent rotation already deleted is no match, never a failure
    const previous = await context.vaultService.get(
      token.vaultName,
      predecessor.secretKey,
      "model:enrollment-token-verify",
    ).catch(() => null);
    matchesPredecessor = previous !== null &&
      timingSafeEqual(previous, args.presentedToken);
  }
  if (!matchesCurrent && !matchesPredecessor) {
    throw new Error(`Enrollment token '${name}' does not match`);
  }
  const mint = matchesCurrent ? token.createdAt : predecessor!.createdAt;

  const existingBinding = token.bindings.find(
    (b) => b.machineId === args.machineId,
  );
  if (existingBinding) {
    if (sameInstant(existingBinding.mint ?? token.createdAt, mint)) {
      return { dataHandles: [] };
    }
    const rebound = {
      ...token,
      bindings: token.bindings.map((b) =>
        b.machineId === args.machineId ? { ...b, mint } : b
      ),
    };
    const handle = await context.writeResource!(
      "token",
      TOKEN_DATA_NAME,
      rebound,
    );
    return { dataHandles: [handle] };
  }

  if (
    token.maxEnrollments !== "unlimited" &&
    token.bindings.length >= token.maxEnrollments
  ) {
    throw new Error(
      `Enrollment token '${name}': enrollment allowance exhausted`,
    );
  }

  const updated = {
    ...token,
    state: "enrolled" as const,
    bindings: [
      ...token.bindings,
      {
        machineId: args.machineId,
        enrolledAt: new Date().toISOString(),
        ...(matchesCurrent ? {} : { mint }),
      },
    ],
  };
  const handle = await context.writeResource!(
    "token",
    TOKEN_DATA_NAME,
    updated,
  );
  return { dataHandles: [handle] };
}

const PruneBindingsArgsSchema = z.object({
  machineIds: z.array(z.string().min(1)).min(1).describe(
    "Machine IDs whose bindings should be removed",
  ),
});

async function pruneBindings(
  args: z.infer<typeof PruneBindingsArgsSchema>,
  context: MethodContext,
): Promise<MethodResult> {
  const token = await readToken(context);
  if (token.state === "unused") {
    throw new Error(
      `Enrollment token '${context.definition.name}' is unused — nothing to prune`,
    );
  }
  const idSet = new Set(args.machineIds);
  const remaining = token.bindings.filter((b) => !idSet.has(b.machineId));
  if (remaining.length === token.bindings.length) {
    return { dataHandles: [] };
  }
  const updated: EnrollmentToken = { ...token, bindings: remaining };
  const handle = await context.writeResource!(
    "token",
    TOKEN_DATA_NAME,
    updated,
  );
  return { dataHandles: [handle] };
}

const EmptyArgsSchema = z.object({});

const RotateArgsSchema = z.object({
  durationMs: z.number().int().positive().optional().describe(
    "Successor lifetime in milliseconds; defaults to the current mint's",
  ),
});

/**
 * replaces the secret in place: the name, bindings and allowance stay, so the
 * worker keeps its identity; the old mint stays redeemable until its own
 * deadline, clamped to the successor's
 */
async function rotate(
  args: z.infer<typeof RotateArgsSchema>,
  context: MethodContext,
): Promise<MethodResult> {
  if (!context.vaultService) {
    throw new Error("Rotating an enrollment token requires a vault service");
  }
  const token = await readToken(context);
  const name = context.definition.name;
  const now = Date.now();
  if (
    token.state === "revoked" || token.state === "expired" ||
    isExpired(token, now)
  ) {
    throw new Error(
      `Enrollment token '${name}' has ${
        token.state === "revoked" ? "been revoked" : "expired"
      } and cannot be rotated — mint a new one with: swamp worker token create ${name} --duration <duration>`,
    );
  }

  const previousCreatedAtMs = Date.parse(token.createdAt);
  // the cut-off verdict orders mints by createdAt, so the successor must be
  // strictly newer even when two rotations land in one millisecond
  const createdAtMs = Math.max(now, previousCreatedAtMs + 1);
  const durationMs = args.durationMs ??
    Date.parse(token.expiresAt) - previousCreatedAtMs;
  const expiresAtMs = createdAtMs + durationMs;

  const secretKey = rotatedTokenSecretKey(name, createdAtMs);
  await context.vaultService.put(
    token.vaultName,
    secretKey,
    generateOpaqueToken(),
  );

  const dropped = token.predecessor;
  const rotated: EnrollmentToken = {
    ...token,
    createdAt: new Date(createdAtMs).toISOString(),
    expiresAt: new Date(expiresAtMs).toISOString(),
    secretKey,
    bindings: token.bindings.map((b) => ({
      ...b,
      mint: b.mint ?? token.createdAt,
    })),
    predecessor: {
      createdAt: token.createdAt,
      expiresAt: new Date(
        Math.min(Date.parse(token.expiresAt), expiresAtMs),
      ).toISOString(),
      secretKey: token.secretKey,
    },
  };
  let handle;
  try {
    handle = await context.writeResource!("token", TOKEN_DATA_NAME, rotated);
  } catch (error) {
    await deleteSecretBestEffort(context, token.vaultName, secretKey);
    throw error;
  }
  if (dropped !== undefined && dropped.secretKey !== secretKey) {
    await deleteSecretBestEffort(context, token.vaultName, dropped.secretKey);
  }
  return { dataHandles: [handle] };
}

const ExpireArgsSchema = z.object({
  mint: z.string().datetime().optional().describe(
    "createdAt of the mint that lapsed; omit for the current mint",
  ),
});

async function revoke(
  _args: z.infer<typeof EmptyArgsSchema>,
  context: MethodContext,
): Promise<MethodResult> {
  const token = await readToken(context);
  if (token.state === "revoked") {
    return { dataHandles: [] };
  }
  const revoked: EnrollmentToken = {
    ...token,
    state: "revoked",
    revokedAt: new Date().toISOString(),
  };
  const handle = await context.writeResource!(
    "token",
    TOKEN_DATA_NAME,
    revoked,
  );
  return { dataHandles: [handle] };
}

async function expire(
  args: z.infer<typeof ExpireArgsSchema>,
  context: MethodContext,
): Promise<MethodResult> {
  const token = await readToken(context);
  if (args.mint !== undefined && !sameInstant(args.mint, token.createdAt)) {
    const predecessor = token.predecessor;
    if (
      predecessor === undefined ||
      !sameInstant(args.mint, predecessor.createdAt)
    ) {
      return { dataHandles: [] };
    }
    const { predecessor: _lapsed, ...current } = token;
    const handle = await context.writeResource!(
      "token",
      TOKEN_DATA_NAME,
      current,
    );
    await deleteSecretBestEffort(
      context,
      token.vaultName,
      predecessor.secretKey,
    );
    return { dataHandles: [handle] };
  }
  if (token.state === "expired" || token.state === "revoked") {
    return { dataHandles: [] };
  }
  const expired: EnrollmentToken = { ...token, state: "expired" };
  const handle = await context.writeResource!(
    "token",
    TOKEN_DATA_NAME,
    expired,
  );
  return { dataHandles: [handle] };
}

export const enrollmentTokenModel: ModelDefinition = defineModel({
  type: ENROLLMENT_TOKEN_MODEL_TYPE,
  version: "2026.11.12.1",
  upgrades: [{
    toVersion: "2026.11.12.1",
    description:
      "Adds token rotation; a token definition has no global arguments to migrate",
    upgradeAttributes: (attributes) => attributes,
  }],
  resources: {
    "token": {
      description:
        "Enrollment token lifecycle (unused → enrolled → expired; revocable)",
      schema: EnrollmentTokenSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    mint: {
      description:
        "Mint a token: write the plaintext to a vault and record the lifecycle aggregate",
      kind: "create",
      arguments: MintArgsSchema,
      execute: mint,
    },
    redeem: {
      description:
        "Redeem at enrollment (appends a binding) or re-authenticate a bound machine",
      kind: "action",
      arguments: RedeemArgsSchema,
      execute: redeem,
    },
    revoke: {
      description: "Invalidate the token before its lifetime expires",
      kind: "action",
      arguments: EmptyArgsSchema,
      execute: revoke,
    },
    rotate: {
      description:
        "Replace the token's secret and lifetime in place, keeping the old secret redeemable until its own expiry",
      kind: "action",
      arguments: RotateArgsSchema,
      execute: rotate,
    },
    expire: {
      description:
        "Record that a mint's lifetime has elapsed (the predecessor's clears it)",
      kind: "action",
      arguments: ExpireArgsSchema,
      execute: expire,
    },
    prune_bindings: {
      description:
        "Remove bindings for specified machine IDs (stale fleet members)",
      kind: "action",
      arguments: PruneBindingsArgsSchema,
      execute: pruneBindings,
    },
  },
});
