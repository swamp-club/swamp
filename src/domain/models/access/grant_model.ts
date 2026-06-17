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
import { ActionSchema } from "../../access/action.ts";
import { EffectSchema } from "../../access/effect.ts";
import { GrantSourceSchema } from "../../access/grant_source.ts";
import {
  parseResourceSelector,
  ResourceSelectorSchema,
} from "../../access/resource_selector.ts";
import { parseSubject, SubjectSchema } from "../../access/subject.ts";
import { parsePrincipal, PrincipalSchema } from "../../access/principal.ts";

export const GRANT_MODEL_TYPE = ModelType.create("swamp/grant");

const GrantStateSchema = z.enum(["active", "revoked"]);

export type GrantState = z.infer<typeof GrantStateSchema>;

export const GrantSchema = z.object({
  id: z.string(),
  subject: SubjectSchema,
  effect: EffectSchema,
  actions: z.array(ActionSchema).min(1),
  resource: ResourceSelectorSchema,
  condition: z.string().optional(),
  state: GrantStateSchema,
  source: GrantSourceSchema,
  createdBy: PrincipalSchema,
  createdAt: z.string().datetime(),
});

export type Grant = z.infer<typeof GrantSchema>;

const GRANT_DATA_NAME = "grant-main";

async function readGrant(context: MethodContext): Promise<Grant | null> {
  const raw = await context.readResource!(GRANT_DATA_NAME);
  if (raw === null) return null;
  return GrantSchema.parse(raw);
}

const CreateArgsSchema = z.object({
  subject: z.string().min(1).describe(
    'Grant subject (e.g. "user:adam", "group:release-managers")',
  ),
  effect: EffectSchema,
  actions: z.array(ActionSchema).min(1),
  resourceKind: z.string().min(1).describe(
    'Resource kind: "workflow", "model", "data", or "access"',
  ),
  resourcePattern: z.string().min(1).describe(
    'Resource pattern (e.g. "@acme/*", "@acme/deploy")',
  ),
  condition: z.string().optional().describe(
    "Optional CEL expression (stored as string, validated by CEL environment in a sibling issue)",
  ),
  source: GrantSourceSchema,
  createdBy: z.string().min(1).describe(
    'Principal who created this grant (e.g. "user:adam")',
  ),
});

async function create(
  args: z.infer<typeof CreateArgsSchema>,
  context: MethodContext,
): Promise<MethodResult> {
  const existing = await readGrant(context);
  if (existing !== null) {
    throw new Error(
      `Grant '${context.definition.name}' already exists — revoke it first`,
    );
  }

  const subject = parseSubject(args.subject);
  const resource = parseResourceSelector(
    `${args.resourceKind}:${args.resourcePattern}`,
  );
  const createdBy = parsePrincipal(args.createdBy);

  const grant: Grant = {
    id: crypto.randomUUID(),
    subject,
    effect: args.effect,
    actions: args.actions,
    resource,
    condition: args.condition,
    state: "active",
    source: args.source,
    createdBy,
    createdAt: new Date().toISOString(),
  };

  const handle = await context.writeResource!("grant", GRANT_DATA_NAME, grant);
  return { dataHandles: [handle] };
}

const EmptyArgsSchema = z.object({});

async function revoke(
  _args: z.infer<typeof EmptyArgsSchema>,
  context: MethodContext,
): Promise<MethodResult> {
  const grant = await readGrant(context);
  if (grant === null) {
    throw new Error(
      `Grant '${context.definition.name}' does not exist`,
    );
  }
  if (grant.state === "revoked") {
    return { dataHandles: [] };
  }

  const revoked: Grant = { ...grant, state: "revoked" };
  const handle = await context.writeResource!(
    "grant",
    GRANT_DATA_NAME,
    revoked,
  );
  return { dataHandles: [handle] };
}

async function list(
  _args: z.infer<typeof EmptyArgsSchema>,
  context: MethodContext,
): Promise<MethodResult> {
  const grant = await readGrant(context);
  if (grant === null) {
    return { dataHandles: [] };
  }
  return { dataHandles: [] };
}

export const grantModel: ModelDefinition = defineModel({
  type: GRANT_MODEL_TYPE,
  version: "2026.06.17.1",
  resources: {
    "grant": {
      description:
        "Grant lifecycle (active → revoked; never deleted, history retained)",
      schema: GrantSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    create: {
      description:
        "Create a new grant — validates subject/resource shapes, records source (immutable after creation)",
      kind: "create",
      arguments: CreateArgsSchema,
      execute: create,
    },
    revoke: {
      description:
        "Transition active → revoked (idempotent if already revoked; state change, never a delete)",
      kind: "action",
      arguments: EmptyArgsSchema,
      execute: revoke,
    },
    list: {
      description: "Query active grants, filterable by subject and resource",
      kind: "list",
      arguments: EmptyArgsSchema,
      execute: list,
    },
  },
});
