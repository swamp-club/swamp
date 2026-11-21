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
import { principalToString } from "./principal.ts";

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

/**
 * never more permissive than either policy: an allow holds only if it is in
 * both, every deny holds, and a group's members are narrowed the way the grants
 * naming it need; a worker, which no grant names, keeps the release's membership
 */
export function narrowedPolicy(
  release: {
    readonly grants: readonly Grant[];
    readonly groups: readonly Group[];
  },
  latest: {
    readonly grants: readonly Grant[];
    readonly groups: readonly Group[];
  },
): { grants: Grant[]; groups: Group[] } {
  const key = (grant: Grant) => JSON.stringify(grant);
  const latestKeys = new Set(latest.grants.map(key));
  const allows = release.grants.filter((grant) =>
    grant.effect === "allow" && latestKeys.has(key(grant))
  );
  const denies = new Map<string, Grant>();
  for (const grant of [...release.grants, ...latest.grants]) {
    if (grant.effect === "deny") denies.set(key(grant), grant);
  }
  const named = (effectGrants: Iterable<Grant>, name: string) =>
    [...effectGrants].some((grant) =>
      grant.subject.kind === "group" && grant.subject.name === name
    );
  const releaseGroups = new Map(release.groups.map((g) => [g.name, g]));
  const latestGroups = new Map(latest.groups.map((g) => [g.name, g]));
  const groups: Group[] = [];
  for (
    const name of new Set([...releaseGroups.keys(), ...latestGroups.keys()])
  ) {
    const before = releaseGroups.get(name);
    const after = latestGroups.get(name);
    const byAllow = named(allows, name);
    const byDeny = named(denies.values(), name);
    if (byAllow && byDeny) {
      const both = (before?.members ?? []).filter((m) =>
        (after?.members ?? []).some((n) =>
          principalToString(n) === principalToString(m)
        )
      );
      const inBoth = new Set(both.map(principalToString));
      const either = [...(before?.members ?? []), ...(after?.members ?? [])]
        .filter((m) => !inBoth.has(principalToString(m)));
      // a worker has no subject kind to name in a deny of its own, so a
      // worker that differs keeps the release's membership; users narrow
      const workers = (before?.members ?? []).filter((m) =>
        m.kind === "worker" && !inBoth.has(principalToString(m))
      );
      const named = either.filter((m) => m.kind !== "worker");
      // the group narrows for its allows; its denies follow each member
      // either side had
      groups.push({ ...(before ?? after)!, members: [...both, ...workers] });
      for (const deny of [...denies.values()]) {
        if (deny.subject.kind !== "group" || deny.subject.name !== name) {
          continue;
        }
        for (const member of named) {
          const copy: Grant = {
            ...deny,
            subject: {
              kind: member.kind as "user" | "service",
              name: member.id,
            },
          };
          denies.set(key(copy), copy);
        }
      }
      continue;
    }
    const base = (before ?? after)!;
    const inAfter = new Set((after?.members ?? []).map(principalToString));
    const inBefore = new Set((before?.members ?? []).map(principalToString));
    const members = byDeny
      ? [
        ...(before?.members ?? []),
        ...(after?.members ?? []).filter((m) =>
          !inBefore.has(principalToString(m))
        ),
      ]
      : (before?.members ?? []).filter((m) =>
        inAfter.has(principalToString(m))
      );
    groups.push({ ...base, members });
  }
  return { grants: [...allows, ...denies.values()], groups };
}
