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
import { assert } from "@std/assert";
import fc from "fast-check";
import { trackedOwnerGone } from "./tracked_owner.ts";

const startTime = fc.option(fc.constantFrom("t1", "t2", "t3"), {
  nil: undefined,
});
const instanceId = fc.option(fc.constantFrom("a", "b"), { nil: undefined });
const pid = fc.constantFrom(2, 3);

const scenario = fc.record({
  rowPid: pid,
  rowStart: startTime,
  rowInstance: instanceId,
  selfStart: startTime,
  selfInstance: instanceId,
  present: fc.boolean(),
  zombie: fc.boolean(),
  probedStart: startTime,
});

type Scenario = typeof scenario extends fc.Arbitrary<infer T> ? T : never;

function judge(s: Scenario): boolean {
  return trackedOwnerGone(
    {
      pid: s.rowPid,
      ownerStartTime: s.rowStart ?? null,
      instanceId: s.rowInstance,
    },
    {
      pid: 2,
      ...(s.selfStart !== undefined ? { startTime: s.selfStart } : {}),
      ...(s.selfInstance !== undefined ? { instanceId: s.selfInstance } : {}),
      probe: () => ({
        present: s.present,
        zombie: s.zombie,
        ...(s.probedStart !== undefined ? { startTime: s.probedStart } : {}),
      }),
    },
  );
}

Deno.test("trackedOwnerGone: another pid that is present and not a zombie is never gone without two differing start times", () => {
  fc.assert(
    fc.property(scenario, (s) => {
      fc.pre(s.rowPid !== 2 && s.present && !s.zombie);
      const proved = s.rowStart !== undefined &&
        s.probedStart !== undefined && s.rowStart !== s.probedStart;
      assert(judge(s) === proved);
    }),
  );
});

Deno.test("trackedOwnerGone: a row stamped with this process's start time is never gone", () => {
  fc.assert(
    fc.property(scenario, (s) => {
      fc.pre(s.rowPid === 2 && s.selfStart !== undefined);
      assert(!judge({ ...s, rowStart: s.selfStart }));
    }),
  );
});

Deno.test("trackedOwnerGone: a pid that is absent or a zombie is always gone", () => {
  fc.assert(
    fc.property(scenario, (s) => {
      fc.pre(s.rowPid !== 2 && (!s.present || s.zombie));
      assert(judge(s));
    }),
  );
});
