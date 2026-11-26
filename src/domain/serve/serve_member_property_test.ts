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

import { assertEquals, assertStrictEquals } from "@std/assert";
import fc from "fast-check";
import type { Fingerprint } from "./fingerprint.ts";
import { sampleFingerprint } from "./federation_test_helpers.ts";
import { InstanceId } from "./instance_id.ts";
import { MemberName } from "./member_name.ts";
import { MemberRoster } from "./member_roster.ts";
import { MAX_INSTANCES, ServeMember } from "./serve_member.ts";

const NOW = Date.parse("2026-11-26T12:00:00.000Z");

const fingerprints: Fingerprint[] = [
  sampleFingerprint(),
  sampleFingerprint({ ready: true, startedAt: "2026-11-26T11:00:00Z" }),
  sampleFingerprint({ authMode: "oauth" }),
  sampleFingerprint({
    workers: { total: 1, byVersion: { v: 1 }, byLabelKey: {} },
  }),
];

type Command =
  | { kind: "checkIn"; instance: number; fingerprint: number; at: number }
  | { kind: "seen"; ages: number[]; at: number }
  | { kind: "remove"; at: number };

const commandArb: fc.Arbitrary<Command> = fc.oneof(
  {
    weight: 6,
    arbitrary: fc.record({
      kind: fc.constant("checkIn" as const),
      instance: fc.integer({ min: 0, max: MAX_INSTANCES + 8 }),
      fingerprint: fc.integer({ min: 0, max: fingerprints.length - 1 }),
      at: fc.integer({ min: 0, max: 2 * 24 * 3600_000 }),
    }),
  },
  {
    weight: 3,
    arbitrary: fc.record({
      kind: fc.constant("seen" as const),
      ages: fc.array(fc.integer({ min: 0, max: 2 * 24 * 3600_000 }), {
        maxLength: 8,
      }),
      at: fc.integer({ min: 0, max: 2 * 24 * 3600_000 }),
    }),
  },
  {
    weight: 1,
    arbitrary: fc.record({
      kind: fc.constant("remove" as const),
      at: fc.nat(1000),
    }),
  },
);

const INSTANCE_IDS = Array.from(
  { length: MAX_INSTANCES + 9 },
  () => InstanceId.create(crypto.randomUUID()),
);

Deno.test("ServeMember property: every change is reported, unchanged commands return the same record", () => {
  fc.assert(
    fc.property(fc.array(commandArb, { maxLength: 120 }), (commands) => {
      let member = ServeMember.join({
        memberId: crypto.randomUUID(),
        name: MemberName.create("edge"),
        role: "member",
        fingerprint: fingerprints[0],
        now: NOW,
      });
      let removed = false;
      for (const cmd of commands) {
        const before = member;
        const beforeJson = JSON.stringify(before.toJSON());
        let changed: boolean;
        if (cmd.kind === "checkIn") {
          const result = member.checkIn(
            INSTANCE_IDS[cmd.instance],
            fingerprints[cmd.fingerprint],
            NOW + cmd.at,
          );
          if (!result.ok) {
            if (result.refusal === "removed") assertEquals(removed, true);
            else assertEquals(member.instances.length, MAX_INSTANCES);
            continue;
          }
          ({ member, changed } = result);
        } else if (cmd.kind === "seen") {
          const at = NOW + cmd.at;
          const seen = new Map(
            member.instances.slice(0, cmd.ages.length).map((instance, i) => [
              instance.instanceId,
              at - cmd.ages[i],
            ]),
          );
          ({ member, changed } = member.applySeen(seen, at));
        } else {
          ({ member, changed } = member.remove(NOW + cmd.at));
          removed = true;
        }
        assertEquals(
          changed,
          member.needsNewVersionFrom(before) || (
            cmd.kind === "remove" && before.status !== "removed"
          ),
        );
        if (!changed) {
          assertStrictEquals(member, before);
          assertEquals(JSON.stringify(member.toJSON()), beforeJson);
        }
        assertEquals(member.instances.length <= MAX_INSTANCES, true);
        assertEquals(
          new Set(member.instanceIds()).size,
          member.instances.length,
        );
        if (removed) assertEquals(member.status, "removed");
      }
    }),
  );
});

Deno.test("ServeMember property: a run of unchanged check-ins writes nothing", () => {
  fc.assert(
    fc.property(
      fc.array(fc.integer({ min: 0, max: 3600_000 }), { minLength: 1 }),
      fc.boolean(),
      (times, runtime) => {
        const id = InstanceId.create(crypto.randomUUID());
        const first = ServeMember.join({
          memberId: crypto.randomUUID(),
          name: MemberName.create("edge"),
          role: "member",
          fingerprint: fingerprints[0],
          now: NOW,
        }).checkIn(id, fingerprints[0], NOW);
        if (!first.ok) throw new Error(first.refusal);
        for (const t of times) {
          const again = first.member.checkIn(
            id,
            fingerprints[runtime ? 1 : 0],
            NOW + t,
          );
          assertEquals(again.ok && again.changed, false);
        }
      },
    ),
  );
});

Deno.test("ServeMember property: a member holds at most MAX_INSTANCES live instances", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: MAX_INSTANCES - 2, max: MAX_INSTANCES + 8 }),
      (count) => {
        let member = ServeMember.join({
          memberId: crypto.randomUUID(),
          name: MemberName.create("edge"),
          role: "member",
          fingerprint: fingerprints[0],
          now: NOW,
        });
        let refused = 0;
        for (const id of INSTANCE_IDS.slice(0, count)) {
          const result = member.checkIn(id, fingerprints[0], NOW);
          if (result.ok) member = result.member;
          else refused++;
        }
        assertEquals(member.instances.length, Math.min(count, MAX_INSTANCES));
        assertEquals(refused, Math.max(0, count - MAX_INSTANCES));
      },
    ),
    { numRuns: 20 },
  );
});

Deno.test("MemberRoster property: admitting through the roster keeps one live member per name, never the hub's", () => {
  const names = ["hub", "a", "b", "c"];
  type Op = { kind: "join"; name: number } | { kind: "remove"; index: number };
  const opArb: fc.Arbitrary<Op> = fc.oneof(
    fc.record({
      kind: fc.constant("join" as const),
      name: fc.integer({ min: 0, max: names.length - 1 }),
    }),
    fc.record({ kind: fc.constant("remove" as const), index: fc.nat(40) }),
  );
  fc.assert(
    fc.property(fc.array(opArb, { maxLength: 40 }), (ops) => {
      const hub = ServeMember.join({
        memberId: crypto.randomUUID(),
        name: MemberName.create("hub"),
        role: "hub",
        fingerprint: fingerprints[0],
        now: NOW,
      });
      const members: ServeMember[] = [hub];
      for (const op of ops) {
        if (op.kind === "join") {
          const name = MemberName.create(names[op.name]);
          if (new MemberRoster(members, "hub").isNameTaken(name)) continue;
          members.push(ServeMember.join({
            memberId: crypto.randomUUID(),
            name,
            role: "member",
            fingerprint: fingerprints[0],
            now: NOW,
          }));
        } else {
          const i = op.index % members.length;
          if (members[i].role === "hub") continue;
          members[i] = members[i].remove(NOW).member;
        }
        assertEquals(MemberRoster.duplicateLiveNames(members), []);
        assertEquals(
          members.filter((m) => m.name === "hub" && m.role !== "hub").length,
          0,
        );
      }
    }),
  );
});
