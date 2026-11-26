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

// registered only through registerFederationModelTypes; models.ts must never import it

import { z } from "zod";
import { ModelType } from "../model_type.ts";
import {
  defineModel,
  type MethodContext,
  type MethodResult,
  type ModelDefinition,
} from "../model.ts";
import { Fingerprint, FingerprintSchema } from "../../serve/fingerprint.ts";
import { MemberName } from "../../serve/member_name.ts";
import {
  MemberRoleSchema,
  ServeMember,
  ServeMemberRecordSchema,
} from "../../serve/serve_member.ts";

export const SERVE_MEMBER_MODEL_TYPE = ModelType.create("swamp/serve-member");

export const SERVE_MEMBER_DATA_NAME = "member-main";

async function readMember(context: MethodContext): Promise<ServeMember | null> {
  const raw = await context.readResource!(SERVE_MEMBER_DATA_NAME);
  return raw === null ? null : ServeMember.fromJSON(raw);
}

async function writeMember(
  context: MethodContext,
  member: ServeMember,
): Promise<MethodResult> {
  const handle = await context.writeResource!(
    "member",
    SERVE_MEMBER_DATA_NAME,
    member.toJSON() as unknown as Record<string, unknown>,
  );
  return { dataHandles: [handle] };
}

const JoinArgsSchema = z.object({
  memberId: z.string().describe("The member's UUID, minted by the hub"),
  role: MemberRoleSchema,
  fingerprint: FingerprintSchema,
  joinedAt: z.string().datetime().optional(),
});

// name uniqueness across members is the hub's check, through MemberRoster
async function join(
  args: z.infer<typeof JoinArgsSchema>,
  context: MethodContext,
): Promise<MethodResult> {
  const existing = await readMember(context);
  if (existing !== null && !existing.isRemoved) {
    throw new Error(
      `Serve member '${context.definition.name}' already exists — remove it before another joins under this name`,
    );
  }
  return await writeMember(
    context,
    ServeMember.join({
      memberId: args.memberId,
      name: MemberName.create(context.definition.name),
      role: args.role,
      fingerprint: Fingerprint.fromJSON(args.fingerprint),
      now: args.joinedAt === undefined ? Date.now() : Date.parse(args.joinedAt),
    }),
  );
}

const RecordArgsSchema = z.object({ record: ServeMemberRecordSchema });

/** writes a record the aggregate produced, and only when the change rule asks for a version */
async function record(
  args: z.infer<typeof RecordArgsSchema>,
  context: MethodContext,
): Promise<MethodResult> {
  const next = ServeMember.fromJSON(args.record);
  const existing = await readMember(context);
  if (existing === null) {
    throw new Error(
      `Serve member '${context.definition.name}' does not exist — join it first`,
    );
  }
  if (
    next.name !== context.definition.name ||
    next.memberId !== existing.memberId
  ) {
    throw new Error(
      `The record is not serve member '${context.definition.name}'`,
    );
  }
  if (existing.isRemoved) {
    throw new Error(
      `Serve member '${context.definition.name}' was removed; its record is final`,
    );
  }
  if (next.isRemoved) {
    throw new Error("A member is removed with the remove method");
  }
  if (!next.needsNewVersionFrom(existing)) return { dataHandles: [] };
  return await writeMember(context, next);
}

const RemoveArgsSchema = z.object({
  removedAt: z.string().datetime().optional(),
});

async function remove(
  args: z.infer<typeof RemoveArgsSchema>,
  context: MethodContext,
): Promise<MethodResult> {
  const existing = await readMember(context);
  if (existing === null) {
    throw new Error(
      `Serve member '${context.definition.name}' does not exist`,
    );
  }
  const now = args.removedAt === undefined
    ? Date.now()
    : Date.parse(args.removedAt);
  const { member, changed } = existing.remove(now);
  if (!changed) return { dataHandles: [] };
  return await writeMember(context, member);
}

export const serveMemberModel: ModelDefinition = defineModel({
  type: SERVE_MEMBER_MODEL_TYPE,
  version: "2026.11.26.1",
  resources: {
    "member": {
      description:
        "A federated serve's record on its hub: identity, fingerprint, status and instances",
      schema: ServeMemberRecordSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    join: {
      description: "Record a member that joined the hub, or the hub itself",
      kind: "create",
      arguments: JoinArgsSchema,
      execute: join,
    },
    record: {
      description:
        "Write the member's next record when the change rule needs a new version",
      kind: "update",
      arguments: RecordArgsSchema,
      execute: record,
    },
    remove: {
      description: "Mark the member removed; a removed member never returns",
      kind: "action",
      arguments: RemoveArgsSchema,
      execute: remove,
    },
  },
});
