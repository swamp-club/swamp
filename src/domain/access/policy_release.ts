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
import { type Grant, GrantSchema } from "../models/access/grant_model.ts";
import { type Group, GroupSchema } from "../models/access/group_model.ts";

const GRANT_RECORD = /^@?swamp\/grant\/[^/]+$/;
const GROUP_RECORD = /^@?swamp\/group\/[^/]+$/;

export const PolicyDecisionSettingsSchema = z.object({
  runImpliesApprove: z.boolean(),
  runImpliesSignal: z.boolean(),
  writeImpliesTag: z.boolean(),
}).strict();

export type PolicyDecisionSettings = z.infer<
  typeof PolicyDecisionSettingsSchema
>;

export const PolicyReleaseSchema = z.object({
  v: z.literal(1),
  grants: z.array(GrantSchema),
  groups: z.array(GroupSchema),
  knownGrants: z.array(
    z.object({ record: z.string().regex(GRANT_RECORD), grant: GrantSchema })
      .strict(),
  ),
  knownGroups: z.array(
    z.object({ record: z.string().regex(GROUP_RECORD), group: GroupSchema })
      .strict(),
  ),
  decisions: PolicyDecisionSettingsSchema,
}).strict();

export type PolicyReleaseAttrs = z.infer<typeof PolicyReleaseSchema>;

/**
 * the policy a leader enforces after a build: what followers enforce in its
 * place, so every node decides alike and a held change stays held
 */
export class PolicyRelease {
  private constructor(
    readonly grants: readonly Grant[],
    readonly groups: readonly Group[],
    readonly knownGrants: ReadonlyMap<string, Grant>,
    readonly knownGroups: ReadonlyMap<string, Group>,
    readonly decisions: PolicyDecisionSettings,
  ) {}

  static of(props: {
    readonly grants: readonly Grant[];
    readonly groups: readonly Group[];
    readonly knownGrants: ReadonlyMap<string, Grant>;
    readonly knownGroups: ReadonlyMap<string, Group>;
    readonly decisions: PolicyDecisionSettings;
  }): PolicyRelease {
    return PolicyRelease.parse(new PolicyRelease(
      props.grants,
      props.groups,
      props.knownGrants,
      props.knownGroups,
      props.decisions,
    ).toAttrs());
  }

  /** throws on anything malformed, or naming a record that is not a grant or group */
  static parse(attrs: unknown): PolicyRelease {
    const parsed = PolicyReleaseSchema.parse(attrs);
    return new PolicyRelease(
      parsed.grants,
      parsed.groups,
      new Map(parsed.knownGrants.map((known) => [known.record, known.grant])),
      new Map(parsed.knownGroups.map((known) => [known.record, known.group])),
      parsed.decisions,
    );
  }

  toAttrs(): PolicyReleaseAttrs {
    return {
      v: 1,
      grants: [...this.grants],
      groups: [...this.groups],
      knownGrants: [...this.knownGrants].map(([record, grant]) => ({
        record,
        grant,
      })),
      knownGroups: [...this.knownGroups].map(([record, group]) => ({
        record,
        group,
      })),
      decisions: { ...this.decisions },
    };
  }

  /** equal for releases that enforce the same policy, whatever their order */
  digest(): string {
    const sorted = (items: readonly unknown[]) =>
      items.map((item) => JSON.stringify(item)).sort();
    return JSON.stringify([
      sorted(this.grants),
      sorted(this.groups),
      sorted([...this.knownGrants].map(([r, g]) => [r, g])),
      sorted([...this.knownGroups].map(([r, g]) => [r, g])),
      this.decisions.runImpliesApprove,
      this.decisions.runImpliesSignal,
      this.decisions.writeImpliesTag,
    ]);
  }
}
