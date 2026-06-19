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
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  lastUsedAt: z.string().datetime().optional(),
  vaultName: z.string(),
  secretKey: z.string(),
  revokedAt: z.string().datetime().optional(),
});

export type ServerToken = z.infer<typeof ServerTokenSchema>;

const TOKEN_DATA_NAME = "token-main";

const DEFAULT_DURATION_MS = 30 * 24 * 60 * 60 * 1000; // ~30 days

export function serverTokenSecretKey(tokenName: string): string {
  return `server-token-${tokenName}`;
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
  vaultName: z.string().min(1),
  durationMs: z.number().int().positive().optional(),
});

async function mint(
  args: z.infer<typeof MintArgsSchema>,
  context: MethodContext,
): Promise<MethodResult> {
  if (!context.vaultService) {
    throw new Error("Minting a server token requires a vault service");
  }
  const existing = await context.readResource!(TOKEN_DATA_NAME);
  if (existing !== null) {
    throw new Error(
      `Server token '${context.definition.name}' already exists — revoke it first`,
    );
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
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + durationMs).toISOString(),
    vaultName: args.vaultName,
    secretKey,
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

  const dotIndex = args.presentedToken.indexOf(".");
  if (dotIndex === -1) {
    throw new Error("Invalid token format: expected <name>.<secret>");
  }

  const token = await readToken(context);
  const name = context.definition.name;

  if (token.state === "revoked") {
    throw new Error(`Server token '${name}' has been revoked`);
  }
  if (token.state === "expired" || isExpired(token, Date.now())) {
    throw new Error(`Server token '${name}' has expired`);
  }

  const presentedName = args.presentedToken.slice(0, dotIndex);
  if (presentedName !== name) {
    throw new Error(
      `Server token name mismatch: expected '${name}'`,
    );
  }

  const presentedSecret = args.presentedToken.slice(dotIndex + 1);
  const secret = await context.vaultService.get(
    token.vaultName,
    token.secretKey,
  );
  if (!timingSafeEqual(secret, presentedSecret)) {
    throw new Error(`Server token '${name}' does not match`);
  }

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
  await context.vaultService.put(existing.vaultName, secretKey, plaintext);

  const now = Date.now();
  const durationMs = args.durationMs ?? DEFAULT_DURATION_MS;
  const token: ServerToken = {
    name,
    state: "active",
    principalId: existing.principalId,
    principalEmail: existing.principalEmail,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + durationMs).toISOString(),
    vaultName: existing.vaultName,
    secretKey,
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
      execute: mint,
    },
    redeem: {
      description:
        "Validate a presented <name>.<secret> token, update lastUsedAt on success",
      kind: "action",
      arguments: RedeemArgsSchema,
      execute: redeem,
    },
    rotate: {
      description:
        "Atomically revoke the current token and mint a replacement with the same name and principal",
      kind: "action",
      arguments: RotateArgsSchema,
      execute: rotate,
    },
    revoke: {
      description: "Revoke the token — takes effect immediately, idempotent",
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
