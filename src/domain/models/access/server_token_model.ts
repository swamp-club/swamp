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
import { ModelType } from "../model_type.ts";
import {
  defineModel,
  type MethodContext,
  type MethodResult,
  type ModelDefinition,
} from "../model.ts";
import { generateOpaqueToken } from "../../remote/session_credential.ts";
import { timingSafeEqual } from "../../crypto/timing_safe_equal.ts";
import { parseCredentialPrincipal } from "../../access/service_principal.ts";

export const SERVER_TOKEN_MODEL_TYPE = ModelType.create(
  "swamp/server-token",
);

const ServerTokenStateSchema = z.enum(["active", "expired", "revoked"]);

export type ServerTokenState = z.infer<typeof ServerTokenStateSchema>;

export const ServerTokenSchema = z.object({
  name: z.string().describe("Token name (user-facing identifier)"),
  state: ServerTokenStateSchema,
  principalId: z.string().describe(
    "Authenticated user's stable subject identifier (OAuth sub claim)",
  ),
  principalEmail: z.string().describe(
    "Display email (informational, not used for matching)",
  ),
  oauthIdentity: z.object({
    email: z.string().min(1),
    username: z.string().min(1).optional(),
  }).optional().describe(
    "Identity the OAuth provider supplied at login; set only by OAuth login, never by a manual mint (swamp-club#3076)",
  ),
  collectives: z.array(z.string()).default([]).describe(
    "Collective memberships snapshotted at login time (from OAuth userinfo)",
  ),
  groups: z.array(z.string()).default([]).describe(
    "IdP group memberships snapshotted at login time (from OAuth userinfo groups field)",
  ),
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  lastUsedAt: z.string().datetime().optional(),
  vaultName: z.string(),
  secretKey: z.string(),
  secretFingerprint: z.string().optional().describe(
    "SHA-256 of the secret this record was minted with; absent on records minted before swamp-club#2482",
  ),
  revokedAt: z.string().datetime().optional(),
});

export type ServerToken = z.infer<typeof ServerTokenSchema>;

const TOKEN_DATA_NAME = "token-main";

const DEFAULT_DURATION_MS = 30 * 24 * 60 * 60 * 1000; // ~30 days

export const SERVER_TOKEN_SECRET_KEY_PREFIX = "server-token-";

export function serverTokenSecretKey(tokenName: string): string {
  return `${SERVER_TOKEN_SECRET_KEY_PREFIX}${tokenName}`;
}

/**
 * Validates a presented credential against a server token lifecycle record.
 * Supplying the vault secret performs the timing-safe credential comparison;
 * omitting it permits callers to reject invalid lifecycle state before a vault
 * read.
 */
export function validateServerToken(
  token: ServerToken,
  name: string,
  presentedToken: string,
  nowMs: number,
  expectedSecret?: string,
): string {
  const dotIndex = presentedToken.indexOf(".");
  if (dotIndex === -1) {
    throw new Error("Invalid token format: expected <name>.<secret>");
  }

  if (token.state === "revoked") {
    throw new Error(`Server token '${name}' has been revoked`);
  }
  if (token.state === "expired" || isExpired(token, nowMs)) {
    throw new Error(`Server token '${name}' has expired`);
  }

  const presentedName = presentedToken.slice(0, dotIndex);
  if (presentedName !== name) {
    throw new Error(
      `Server token name mismatch: expected '${name}'`,
    );
  }

  const presentedSecret = presentedToken.slice(dotIndex + 1);
  if (
    expectedSecret !== undefined &&
    !timingSafeEqual(expectedSecret, presentedSecret)
  ) {
    throw new Error(`Server token '${name}' does not match`);
  }
  return presentedSecret;
}

/**
 * The value a token record stores to name the secret it was minted with: the
 * hex SHA-256 of the plaintext. The plaintext is 32 random bytes, so the
 * unsalted hash reveals nothing about it.
 */
export async function serverTokenSecretFingerprint(
  secret: string,
): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(secret),
  );
  return Array.from(
    new Uint8Array(digest),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
}

/**
 * The record and the vault secret of a token come from different mints
 * (swamp-club#2482). The token cannot authenticate until it is rotated.
 */
export class ServerTokenSecretMismatchError extends Error {
  constructor(name: string) {
    super(
      `Server token '${name}' is inconsistent: its record and its secret ` +
        `come from different mints — rotate it`,
    );
    this.name = "ServerTokenSecretMismatchError";
  }
}

/**
 * Checks that the secret read from the vault is the one the record was minted
 * with. The record and the secret live in separate stores, so two writers of
 * one name can leave one mint's record beside another's secret. A record
 * without a fingerprint predates the check and passes.
 */
export async function verifyServerTokenSecret(
  token: ServerToken,
  secret: string,
): Promise<void> {
  if (token.secretFingerprint === undefined) return;
  const actual = await serverTokenSecretFingerprint(secret);
  if (!timingSafeEqual(token.secretFingerprint, actual)) {
    throw new ServerTokenSecretMismatchError(token.name);
  }
}

async function readToken(context: MethodContext): Promise<ServerToken> {
  const raw = await context.readResource!(TOKEN_DATA_NAME);
  if (raw === null) {
    throw new Error(
      `Server token '${context.definition.name}' does not exist — mint it first`,
    );
  }
  return ServerTokenSchema.parse(raw);
}

function isExpired(token: ServerToken, nowMs: number): boolean {
  return Date.parse(token.expiresAt) <= nowMs;
}

const MintArgsSchema = z.object({
  principalId: z.string().min(1),
  principalEmail: z.string().min(1),
  collectives: z.array(z.string()).default([]),
  groups: z.array(z.string()).default([]),
  vaultName: z.string().min(1),
  durationMs: z.number().int().positive().optional(),
});

async function mint(
  args: z.infer<typeof MintArgsSchema>,
  context: MethodContext,
): Promise<MethodResult> {
  // A token whose principal serve cannot parse will be rejected on every
  // connection, so refuse it at mint time (swamp-club#2383). Service
  // principals act only in-process and never hold a credential.
  parseCredentialPrincipal(args.principalId);
  if (!context.vaultService) {
    throw new Error("Minting a server token requires a vault service");
  }
  const existing = await context.readResource!(TOKEN_DATA_NAME);
  if (existing !== null) {
    const parsed = ServerTokenSchema.parse(existing);
    if (
      parsed.state !== "revoked" && parsed.state !== "expired" &&
      !isExpired(parsed, Date.now())
    ) {
      throw new Error(
        `Server token '${context.definition.name}' already exists — revoke it or wait for expiry before re-minting`,
      );
    }
  }

  const name = context.definition.name;
  const secretKey = serverTokenSecretKey(name);
  const plaintext = generateOpaqueToken();
  await context.vaultService.put(args.vaultName, secretKey, plaintext);

  const now = Date.now();
  const durationMs = args.durationMs ?? DEFAULT_DURATION_MS;
  const token: ServerToken = {
    name,
    state: "active",
    principalId: args.principalId,
    principalEmail: args.principalEmail,
    collectives: args.collectives,
    groups: args.groups,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + durationMs).toISOString(),
    vaultName: args.vaultName,
    secretKey,
    secretFingerprint: await serverTokenSecretFingerprint(plaintext),
  };
  const handle = await context.writeResource!("token", TOKEN_DATA_NAME, token);
  return { dataHandles: [handle] };
}

const RedeemArgsSchema = z.object({
  presentedToken: z.string().min(1),
});

async function redeem(
  args: z.infer<typeof RedeemArgsSchema>,
  context: MethodContext,
): Promise<MethodResult> {
  if (!context.vaultService) {
    throw new Error("Redeeming a server token requires a vault service");
  }

  const token = await readToken(context);
  const name = context.definition.name;
  const nowMs = Date.now();
  validateServerToken(token, name, args.presentedToken, nowMs);
  const secret = await context.vaultService.get(
    token.vaultName,
    token.secretKey,
    "model:server-token-verify",
  );
  validateServerToken(token, name, args.presentedToken, nowMs, secret);
  await verifyServerTokenSecret(token, secret);

  const updated: ServerToken = {
    ...token,
    lastUsedAt: new Date().toISOString(),
  };
  const handle = await context.writeResource!(
    "token",
    TOKEN_DATA_NAME,
    updated,
  );
  return { dataHandles: [handle] };
}

const RotateArgsSchema = z.object({
  durationMs: z.number().int().positive().optional(),
  vaultName: z.string().min(1).optional(),
});

async function rotate(
  args: z.infer<typeof RotateArgsSchema>,
  context: MethodContext,
): Promise<MethodResult> {
  if (!context.vaultService) {
    throw new Error("Rotating a server token requires a vault service");
  }
  const existing = await readToken(context);
  const name = context.definition.name;
  const secretKey = serverTokenSecretKey(name);
  const plaintext = generateOpaqueToken();
  const vaultName = args.vaultName ?? existing.vaultName;
  await context.vaultService.put(vaultName, secretKey, plaintext);

  const now = Date.now();
  const durationMs = args.durationMs ?? DEFAULT_DURATION_MS;
  const token: ServerToken = {
    name,
    state: "active",
    principalId: existing.principalId,
    principalEmail: existing.principalEmail,
    ...(existing.oauthIdentity
      ? { oauthIdentity: existing.oauthIdentity }
      : {}),
    collectives: existing.collectives,
    groups: existing.groups,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + durationMs).toISOString(),
    vaultName,
    secretKey,
    secretFingerprint: await serverTokenSecretFingerprint(plaintext),
  };
  const handle = await context.writeResource!("token", TOKEN_DATA_NAME, token);
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
  const revoked: ServerToken = {
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

const UpdateCollectivesArgsSchema = z.object({
  collectives: z.array(z.string()),
  groups: z.array(z.string()).default([]),
});

async function updateCollectives(
  args: z.infer<typeof UpdateCollectivesArgsSchema>,
  context: MethodContext,
): Promise<MethodResult> {
  const token = await readToken(context);
  if (token.state !== "active") {
    return { dataHandles: [] };
  }
  if (isExpired(token, Date.now())) {
    return { dataHandles: [] };
  }
  const updated: ServerToken = {
    ...token,
    collectives: args.collectives,
    groups: args.groups,
  };
  const handle = await context.writeResource!(
    "token",
    TOKEN_DATA_NAME,
    updated,
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
  const expired: ServerToken = { ...token, state: "expired" };
  const handle = await context.writeResource!(
    "token",
    TOKEN_DATA_NAME,
    expired,
  );
  return { dataHandles: [handle] };
}

export const serverTokenModel: ModelDefinition = defineModel({
  type: SERVER_TOKEN_MODEL_TYPE,
  version: "2026.06.18.1",
  resources: {
    "token": {
      description: "Server token lifecycle (active → expired | revoked)",
      schema: ServerTokenSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
  },
  methods: {
    mint: {
      description:
        "Mint a server token: write the plaintext to a vault and record the lifecycle aggregate",
      kind: "create",
      arguments: MintArgsSchema,
      outputLifetime: "7d",
      execute: mint,
    },
    redeem: {
      description:
        "Validate a presented <name>.<secret> token, update lastUsedAt on success",
      kind: "action",
      arguments: RedeemArgsSchema,
      outputLifetime: "1d",
      execute: redeem,
    },
    rotate: {
      description:
        "Atomically revoke the current token and mint a replacement with the same name and principal",
      kind: "action",
      arguments: RotateArgsSchema,
      outputLifetime: "7d",
      execute: rotate,
    },
    revoke: {
      description: "Revoke the token — takes effect immediately, idempotent",
      kind: "action",
      arguments: EmptyArgsSchema,
      outputLifetime: "7d",
      execute: revoke,
    },
    expire: {
      description: "Record that the token lifetime has elapsed",
      kind: "action",
      arguments: EmptyArgsSchema,
      outputLifetime: "7d",
      execute: expire,
    },
    updateCollectives: {
      description:
        "Update the collective memberships on an active token (used by the background refresh loop)",
      kind: "action",
      arguments: UpdateCollectivesArgsSchema,
      outputLifetime: "1d",
      execute: updateCollectives,
    },
  },
});
