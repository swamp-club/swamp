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
 * Built-in enrollment-token model (see design/remote-execution.md,
 * "Enrollment tokens").
 *
 * One model instance per token, named by the token name. The token's
 * plaintext only ever lives in a vault — the resource records the vault
 * reference and the lifecycle state machine `unused → enrolled → expired`
 * (plus `revoked`). First redemption binds the token to the presenting
 * machine id; the bound machine may redeem again (worker restarts and
 * reboots) until the lifetime expires, while any other machine is rejected.
 * The datastore provides no compare-and-swap, so the `unused → enrolled`
 * transition is made atomic by the orchestrator process serializing all
 * token transitions in memory — it is the sole writer of this model.
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

export const EnrollmentTokenSchema = z.object({
  name: z.string().describe("Token name; the worker's pool-addressable handle"),
  state: TokenStateSchema,
  createdAt: z.string().datetime(),
  /** Bounds both the enrollment window and the reconnection window. */
  expiresAt: z.string().datetime(),
  /** Vault reference to the token plaintext — never the secret itself. */
  vaultName: z.string(),
  secretKey: z.string(),
  /** Durable machine id bound on first redemption. */
  boundMachineId: z.string().optional(),
  enrolledAt: z.string().datetime().optional(),
  revokedAt: z.string().datetime().optional(),
});

export type EnrollmentToken = z.infer<typeof EnrollmentTokenSchema>;

const TOKEN_DATA_NAME = "token-main";

/** Vault key under which a token's plaintext is stored. */
export function tokenSecretKey(tokenName: string): string {
  return `worker-token-${tokenName}`;
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

const MintArgsSchema = z.object({
  durationMs: z.number().int().positive().describe(
    "Token lifetime in milliseconds",
  ),
  vaultName: z.string().min(1).describe(
    "Vault that stores the token plaintext",
  ),
});

async function mint(
  args: z.infer<typeof MintArgsSchema>,
  context: MethodContext,
): Promise<MethodResult> {
  if (!context.vaultService) {
    throw new Error("Minting an enrollment token requires a vault service");
  }
  const existing = await context.readResource!(TOKEN_DATA_NAME);
  if (existing !== null) {
    throw new Error(
      `Enrollment token '${context.definition.name}' already exists — revoke it and mint a new name, or pick another name`,
    );
  }

  const name = context.definition.name;
  const secretKey = tokenSecretKey(name);
  const plaintext = generateOpaqueToken();
  await context.vaultService.put(args.vaultName, secretKey, plaintext);

  const now = Date.now();
  const token: EnrollmentToken = {
    name,
    state: "unused",
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + args.durationMs).toISOString(),
    vaultName: args.vaultName,
    secretKey,
  };
  const handle = await context.writeResource!("token", TOKEN_DATA_NAME, token);
  return { dataHandles: [handle] };
}

const RedeemArgsSchema = z.object({
  presentedToken: z.string().min(1),
  machineId: z.string().min(1),
});

/**
 * Redeem the token at enrollment, or re-authenticate the bound machine on
 * reconnect or restart. First redemption transitions `unused → enrolled` and
 * binds the machine id (a new resource version); a matching re-redemption
 * validates without writing. Expiry is a hard deadline for both: past
 * `expiresAt` even the bound machine is rejected. Every failure throws.
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
  );
  if (!timingSafeEqual(secret, args.presentedToken)) {
    throw new Error(`Enrollment token '${name}' does not match`);
  }

  if (token.state === "enrolled") {
    if (token.boundMachineId === args.machineId) {
      // Re-authentication of the bound machine: valid, no state change.
      return { dataHandles: [] };
    }
    if (token.boundMachineId !== undefined) {
      throw new Error(
        `Enrollment token '${name}' is already bound to another machine`,
      );
    }
    // Enrolled before machine binding existed: adopt the presenting machine.
    const adopted: EnrollmentToken = {
      ...token,
      boundMachineId: args.machineId,
    };
    const handle = await context.writeResource!(
      "token",
      TOKEN_DATA_NAME,
      adopted,
    );
    return { dataHandles: [handle] };
  }

  const enrolled: EnrollmentToken = {
    ...token,
    state: "enrolled",
    boundMachineId: args.machineId,
    enrolledAt: new Date().toISOString(),
  };
  const handle = await context.writeResource!(
    "token",
    TOKEN_DATA_NAME,
    enrolled,
  );
  return { dataHandles: [handle] };
}

const EmptyArgsSchema = z.object({});

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
  _args: z.infer<typeof EmptyArgsSchema>,
  context: MethodContext,
): Promise<MethodResult> {
  const token = await readToken(context);
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

/**
 * The enrollment-token model definition. Self-registers via the models
 * barrel.
 */
export const enrollmentTokenModel: ModelDefinition = defineModel({
  type: ENROLLMENT_TOKEN_MODEL_TYPE,
  version: "2026.06.11.1",
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
        "Redeem at enrollment (unused → enrolled, binds machine id) or re-authenticate the bound machine",
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
    expire: {
      description: "Record that the token lifetime has elapsed",
      kind: "action",
      arguments: EmptyArgsSchema,
      execute: expire,
    },
  },
});
