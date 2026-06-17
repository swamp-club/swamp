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
import {
  parsePrincipal,
  PrincipalSchema,
  principalToString,
} from "../../access/principal.ts";

export const GROUP_MODEL_TYPE = ModelType.create("swamp/group");

export const GroupSchema = z.object({
  name: z.string().min(1),
  members: z.array(PrincipalSchema),
  createdBy: PrincipalSchema,
  createdAt: z.string().datetime(),
});

export type Group = z.infer<typeof GroupSchema>;

const GROUP_DATA_NAME = "group-main";

async function readGroup(context: MethodContext): Promise<Group | null> {
  const raw = await context.readResource!(GROUP_DATA_NAME);
  if (raw === null) return null;
  return GroupSchema.parse(raw);
}

const CreateArgsSchema = z.object({
  createdBy: z.string().min(1).describe(
    'Principal who created this group (e.g. "user:adam")',
  ),
});

async function create(
  args: z.infer<typeof CreateArgsSchema>,
  context: MethodContext,
): Promise<MethodResult> {
  const existing = await readGroup(context);
  if (existing !== null) {
    throw new Error(
      `Group '${context.definition.name}' already exists`,
    );
  }

  const createdBy = parsePrincipal(args.createdBy);

  const group: Group = {
    name: context.definition.name,
    members: [],
    createdBy,
    createdAt: new Date().toISOString(),
  };

  const handle = await context.writeResource!(
    "group",
    GROUP_DATA_NAME,
    group,
  );
  return { dataHandles: [handle] };
}

const MemberArgsSchema = z.object({
  principal: z.string().min(1).describe(
    'Principal to add/remove (e.g. "user:adam")',
  ),
});

async function addMember(
  args: z.infer<typeof MemberArgsSchema>,
  context: MethodContext,
): Promise<MethodResult> {
  const group = await readGroup(context);
  if (group === null) {
    throw new Error(
      `Group '${context.definition.name}' does not exist — create it first`,
    );
  }

  const principal = parsePrincipal(args.principal);
  const principalStr = principalToString(principal);

  const alreadyMember = group.members.some(
    (m) => principalToString(m) === principalStr,
  );
  if (alreadyMember) {
    return { dataHandles: [] };
  }

  const updated: Group = {
    ...group,
    members: [...group.members, principal],
  };
  const handle = await context.writeResource!(
    "group",
    GROUP_DATA_NAME,
    updated,
  );
  return { dataHandles: [handle] };
}

async function removeMember(
  args: z.infer<typeof MemberArgsSchema>,
  context: MethodContext,
): Promise<MethodResult> {
  const group = await readGroup(context);
  if (group === null) {
    throw new Error(
      `Group '${context.definition.name}' does not exist — create it first`,
    );
  }

  const principal = parsePrincipal(args.principal);
  const principalStr = principalToString(principal);

  const filtered = group.members.filter(
    (m) => principalToString(m) !== principalStr,
  );
  if (filtered.length === group.members.length) {
    return { dataHandles: [] };
  }

  const updated: Group = { ...group, members: filtered };
  const handle = await context.writeResource!(
    "group",
    GROUP_DATA_NAME,
    updated,
  );
  return { dataHandles: [handle] };
}

const EmptyArgsSchema = z.object({});

async function list(
  _args: z.infer<typeof EmptyArgsSchema>,
  context: MethodContext,
): Promise<MethodResult> {
  await readGroup(context);
  return { dataHandles: [] };
}

async function members(
  _args: z.infer<typeof EmptyArgsSchema>,
  context: MethodContext,
): Promise<MethodResult> {
  const group = await readGroup(context);
  if (group === null) {
    throw new Error(
      `Group '${context.definition.name}' does not exist`,
    );
  }
  return { dataHandles: [] };
}

export const groupModel: ModelDefinition = defineModel({
  type: GROUP_MODEL_TYPE,
  version: "2026.06.17.1",
  resources: {
    "group": {
      description: "Group membership (locally-managed principals)",
      schema: GroupSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    create: {
      description: "Create a new named group",
      kind: "create",
      arguments: CreateArgsSchema,
      execute: create,
    },
    "add-member": {
      description:
        "Add a principal to the group (idempotent if already a member)",
      kind: "action",
      arguments: MemberArgsSchema,
      execute: addMember,
    },
    "remove-member": {
      description: "Remove a principal from the group (no-op if not a member)",
      kind: "action",
      arguments: MemberArgsSchema,
      execute: removeMember,
    },
    list: {
      description: "List all groups",
      kind: "list",
      arguments: EmptyArgsSchema,
      execute: list,
    },
    members: {
      description: "List members of a specific group",
      kind: "read",
      arguments: EmptyArgsSchema,
      execute: members,
    },
  },
});
