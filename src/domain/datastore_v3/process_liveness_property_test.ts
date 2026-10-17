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
import {
  judgeRecordedProcess,
  type ProcessIdentity,
  type ProcessProbe,
} from "./process_liveness.ts";

const arbIdentity: fc.Arbitrary<ProcessIdentity> = fc.record({
  host: fc.constantFrom("h1", "h1#pid:[1]", "h1#pid:[2]", "h2"),
  bootId: fc.option(fc.constantFrom("b1", "b2"), { nil: undefined }),
  startTime: fc.option(fc.constantFrom("t1", "t2"), { nil: undefined }),
}, { requiredKeys: ["host"] });

const arbProbe: fc.Arbitrary<ProcessProbe> = fc.record({
  present: fc.boolean(),
  zombie: fc.boolean(),
  startTime: fc.option(fc.constantFrom("t1", "t2"), { nil: undefined }),
}, { requiredKeys: ["present", "zombie"] });

const arbCase = fc.record({
  pid: fc.integer({ min: 1, max: 4 }),
  recorded: fc.option(arbIdentity, { nil: undefined }),
  notThisProcess: fc.boolean(),
  here: arbIdentity,
  probe: arbProbe,
  bootIdRequired: fc.boolean(),
});

Deno.test("judgeRecordedProcess: a record not written on this kernel is never judged gone", () => {
  fc.assert(
    fc.property(arbCase, (c) => {
      const verdict = judgeRecordedProcess(
        {
          pid: c.pid,
          ...(c.recorded !== undefined ? { process: c.recorded } : {}),
          notThisProcess: c.notThisProcess,
        },
        {
          pid: 1,
          identity: c.here,
          probe: () => c.probe,
          bootIdRequired: c.bootIdRequired,
        },
      );
      // Where the platform has boot ids, none on both sides places nothing.
      const sameKernel = c.recorded !== undefined &&
        c.recorded.host === c.here.host &&
        c.recorded.bootId === c.here.bootId &&
        (!c.bootIdRequired || c.here.bootId !== undefined);
      if (!sameKernel) assert(verdict === "unknown", `got ${verdict}`);
      else assert(verdict !== "unknown", "a same-kernel record is judged");
    }),
  );
});

Deno.test("judgeRecordedProcess: an unreadable start time never turns a present pid gone", () => {
  fc.assert(
    fc.property(
      arbIdentity,
      arbProbe,
      fc.boolean(),
      fc.boolean(),
      (here, probe, recordedSide, bootIdRequired) => {
        // A kernel judged by pid: where boot ids exist, it has one.
        fc.pre(!bootIdRequired || here.bootId !== undefined);
        // Same kernel; one side's start time unreadable.
        const { startTime: _, ...unstamped } = here;
        const verdict = judgeRecordedProcess(
          { pid: 2, process: recordedSide ? unstamped : here },
          {
            pid: 1,
            identity: here,
            probe: () => ({
              present: true,
              zombie: false,
              ...(recordedSide && probe.startTime !== undefined
                ? { startTime: probe.startTime }
                : {}),
            }),
            bootIdRequired,
          },
        );
        assert(verdict === "alive", `got ${verdict}`);
      },
    ),
  );
});
