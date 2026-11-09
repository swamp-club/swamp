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
import { Ceiling } from "../../access/ceiling.ts";
import { INTEGRATION_ID_PATTERN } from "../../access/client.ts";
import { INTEGRATION_CREDENTIAL_HASH_PATTERN } from "../../access/integration_credential.ts";
import { ModelType } from "../model_type.ts";
import {
  defineModel,
  type MethodContext,
  type MethodResult,
  type ModelDefinition,
} from "../model.ts";

export const INTEGRATION_MODEL_TYPE = ModelType.create("swamp/integration");

export const INTEGRATION_DATA_NAME = "integration-main";

export const MAX_INTEGRATION_NAME_LENGTH = 200;

const IntegrationStateSchema = z.enum(["active", "revoked"]);

export type IntegrationState = z.infer<typeof IntegrationStateSchema>;

// the ceiling stays loose here: a version this build cannot read must refuse
// that integration when decided on, not hide its record from list and revoke
export const IntegrationSchema = z.object({
  id: z.string().regex(INTEGRATION_ID_PATTERN),
  name: z.string().min(1).max(MAX_INTEGRATION_NAME_LENGTH),
  credentialHash: z.string().regex(INTEGRATION_CREDENTIAL_HASH_PATTERN),
  ceiling: z.unknown(),
  ceilingDigest: z.string(),
  previousCeilingDigest: z.string().optional(),
  state: IntegrationStateSchema,
  createdAt: z.string().datetime(),
  ceilingChangedAt: z.string().datetime().optional(),
  revokedAt: z.string().datetime().optional(),
  // absent means false
  requireEmailMatch: z.boolean().optional(),
});

export type Integration = z.infer<typeof IntegrationSchema>;

/** the longest id whose `integration-<id>` still fits a behavior name */
export const INTEGRATION_ID_MAX_LENGTH = 52;

/** behavior names share one namespace across types, so an id gets its own room */
export function integrationDefinitionName(id: string): string {
  return `integration-${id}`;
}

/**
 * the id's own UUID, so every first write of an id reaches one record: no store
 * here can refuse a create, and a second record would make every node refuse it
 */
export async function integrationDefinitionId(
  definitionName: string,
): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(
      `${INTEGRATION_MODEL_TYPE.normalized}:${definitionName}`,
    ),
  );
  const bytes = new Uint8Array(digest).slice(0, 16);
  // RFC 9562 UUIDv8: application-defined bits, in a valid UUID's shape
  bytes[6] = (bytes[6] & 0x0f) | 0x80;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(
    "",
  );
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${
    hex.slice(16, 20)
  }-${hex.slice(20)}`;
}

async function readIntegration(
  context: MethodContext,
): Promise<Integration | null> {
  const raw = await context.readResource!(INTEGRATION_DATA_NAME);
  if (raw === null) return null;
  return IntegrationSchema.parse(raw);
}

const RegisterArgsSchema = z.object({
  id: z.string().regex(
    INTEGRATION_ID_PATTERN,
    "An integration id is lowercase letters, digits and hyphens",
  ).max(INTEGRATION_ID_MAX_LENGTH),
  name: z.string().min(1).max(MAX_INTEGRATION_NAME_LENGTH),
  ceiling: z.unknown(),
  credentialHash: z.string().regex(
    INTEGRATION_CREDENTIAL_HASH_PATTERN,
    "Expected the credential's sha256 hash, never the credential",
  ),
  requireEmailMatch: z.boolean().optional(),
});

export function integrationIdTakenMessage(id: string, state: string): string {
  return state === "revoked"
    ? `Integration '${id}' was revoked, and a revoked id can't be used again: tokens issued to it would come back to life`
    : `Integration '${id}' already exists`;
}

async function register(
  args: z.infer<typeof RegisterArgsSchema>,
  context: MethodContext,
): Promise<MethodResult> {
  if (context.definition.name !== integrationDefinitionName(args.id)) {
    throw new Error(
      `Integration '${args.id}' must be registered on the behavior named ${
        integrationDefinitionName(args.id)
      }`,
    );
  }
  const existing = await readIntegration(context);
  if (existing !== null) {
    throw new Error(integrationIdTakenMessage(args.id, existing.state));
  }
  const ceiling = Ceiling.parse(args.ceiling);
  const integration: Integration = {
    id: args.id,
    name: args.name,
    credentialHash: args.credentialHash,
    ceiling: ceiling.toDocument(),
    ceilingDigest: await ceiling.digest(),
    state: "active",
    createdAt: new Date().toISOString(),
    ...(args.requireEmailMatch ? { requireEmailMatch: true } : {}),
  };
  const handle = await context.writeResource!(
    "integration",
    INTEGRATION_DATA_NAME,
    integration,
  );
  return { dataHandles: [handle] };
}

const SetCeilingArgsSchema = z.object({ ceiling: z.unknown() });

async function setCeiling(
  args: z.infer<typeof SetCeilingArgsSchema>,
  context: MethodContext,
): Promise<MethodResult> {
  const integration = await readIntegration(context);
  if (integration === null) {
    throw new Error(
      `Integration '${
        context.definition.name.replace(/^integration-/, "")
      }' does not exist`,
    );
  }
  if (integration.state === "revoked") {
    throw new Error(
      `Integration '${integration.id}' was revoked, and its ceiling can't be changed`,
    );
  }
  const ceiling = Ceiling.parse(args.ceiling);
  const updated: Integration = {
    ...integration,
    ceiling: ceiling.toDocument(),
    ceilingDigest: await ceiling.digest(),
    previousCeilingDigest: integration.ceilingDigest,
    ceilingChangedAt: new Date().toISOString(),
  };
  const handle = await context.writeResource!(
    "integration",
    INTEGRATION_DATA_NAME,
    updated,
  );
  return { dataHandles: [handle] };
}

const EmptyArgsSchema = z.object({});

async function revoke(
  _args: z.infer<typeof EmptyArgsSchema>,
  context: MethodContext,
): Promise<MethodResult> {
  const integration = await readIntegration(context);
  if (integration === null) {
    throw new Error(
      `Integration '${
        context.definition.name.replace(/^integration-/, "")
      }' does not exist`,
    );
  }
  if (integration.state === "revoked") return { dataHandles: [] };
  const revoked: Integration = {
    ...integration,
    state: "revoked",
    revokedAt: new Date().toISOString(),
  };
  const handle = await context.writeResource!(
    "integration",
    INTEGRATION_DATA_NAME,
    revoked,
  );
  return { dataHandles: [handle] };
}

export const integrationModel: ModelDefinition = defineModel({
  type: INTEGRATION_MODEL_TYPE,
  version: "2026.11.07.1",
  resources: {
    "integration": {
      description:
        "An app an admin registered: its ceiling and state (active → revoked; never deleted, so an id stays reserved)",
      schema: IntegrationSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    register: {
      description:
        "Register an integration with its ceiling and the hash of its credential; refuses an id already used",
      kind: "create",
      arguments: RegisterArgsSchema,
      execute: register,
    },
    setCeiling: {
      description: "Replace an active integration's ceiling",
      kind: "action",
      arguments: SetCeilingArgsSchema,
      execute: setCeiling,
    },
    revoke: {
      description:
        "Transition active → revoked (idempotent if already revoked; final, never a delete)",
      kind: "action",
      arguments: EmptyArgsSchema,
      execute: revoke,
    },
  },
});
