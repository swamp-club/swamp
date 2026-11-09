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

import { assertEquals, assertThrows } from "@std/assert";
import {
  FanOutPolicySchema,
  hasLane,
  parsePercent,
  resolveMaxFailures,
  RolloutPolicySchema,
} from "./fan_out.ts";

Deno.test("FanOutPolicySchema: defaults to offline wait and minWorkers 1", () => {
  assertEquals(FanOutPolicySchema.parse({}), {
    offline: "wait",
    minWorkers: 1,
  });
});

Deno.test("FanOutPolicySchema: refuses minWorkers below 1 and unknown offline policies", () => {
  for (
    const policy of [{ minWorkers: 0 }, { minWorkers: 1.5 }, {
      offline: "retry",
    }]
  ) {
    assertEquals(
      FanOutPolicySchema.safeParse(policy).success,
      false,
      JSON.stringify(policy),
    );
  }
});

Deno.test("RolloutPolicySchema: accepts counts and percentages ending in 100%", () => {
  for (
    const rollout of [
      { batches: ["100%"] },
      { batches: [1, 2, "100%"], maxFailures: 0 },
      { batches: ["10%", 3, "100%"], maxFailures: "10%" },
      { batches: ["1%", "100%"], maxFailures: "0%" },
      { batches: ["100%"], maxFailures: "100%" },
    ]
  ) {
    assertEquals(
      RolloutPolicySchema.safeParse(rollout).success,
      true,
      JSON.stringify(rollout),
    );
  }
});

Deno.test("RolloutPolicySchema: refuses bad batch lists and budgets", () => {
  for (
    const rollout of [
      { batches: [] },
      { batches: [1, 2] },
      { batches: ["100%", 1] },
      { batches: ["100%", "100%"] },
      { batches: [0, "100%"] },
      { batches: [-1, "100%"] },
      { batches: [1.5, "100%"] },
      { batches: ["0%", "100%"] },
      { batches: ["101%"] },
      { batches: ["1.5%", "100%"] },
      { batches: ["%", "100%"] },
      { batches: ["10", "100%"] },
      { batches: ["100%"], maxFailures: -1 },
      { batches: ["100%"], maxFailures: 0.5 },
      { batches: ["100%"], maxFailures: "101%" },
      { batches: ["100%"], maxFailures: "-1%" },
    ]
  ) {
    assertEquals(
      RolloutPolicySchema.safeParse(rollout).success,
      false,
      JSON.stringify(rollout),
    );
  }
});

Deno.test("RolloutPolicySchema: accepts approval gates", () => {
  for (
    const rollout of [
      { batches: ["100%"], approve: ["plan"] },
      { batches: [1, "100%"], approve: ["canary"] },
      { batches: [1, 2, "100%"], approve: ["plan", "canary"] },
      { batches: [1, "100%"], approve: ["canary", "plan"], approveTimeout: 60 },
    ]
  ) {
    assertEquals(
      RolloutPolicySchema.safeParse(rollout).success,
      true,
      JSON.stringify(rollout),
    );
  }
});

Deno.test("RolloutPolicySchema: refuses gates it cannot open", () => {
  for (
    const [rollout, message] of [
      [{ batches: ["100%"], approve: ["canary"] }, "canary needs a batch"],
      [{ batches: ["100%"], approve: ["plan", "canary"] }, "canary needs"],
      [{ batches: ["100%"], approve: ["deploy"] }, "Invalid"],
      [{ batches: ["100%"], approve: [] }, ""],
      [{ batches: ["100%"], approve: ["plan", "plan"] }, "more than once"],
      [{ batches: ["100%"], approveTimeout: 60 }, "approveTimeout needs"],
      [{ batches: ["100%"], approve: ["plan"], approveTimeout: 0 }, ""],
      [{ batches: ["100%"], approve: ["plan"], approveTimeout: 1.5 }, ""],
    ] as const
  ) {
    const parsed = RolloutPolicySchema.safeParse(rollout);
    assertEquals(parsed.success, false, JSON.stringify(rollout));
    if (!parsed.success && message !== "") {
      assertEquals(
        parsed.error.issues.some((issue) => issue.message.includes(message)),
        true,
        `${JSON.stringify(rollout)}: ${JSON.stringify(parsed.error.issues)}`,
      );
    }
  }
});

Deno.test("parsePercent: reads whole percentages only", () => {
  assertEquals(parsePercent("25%"), 25);
  assertEquals(parsePercent("0%"), 0);
  assertEquals(parsePercent("25"), null);
  assertEquals(parsePercent("2.5%"), null);
  assertEquals(parsePercent(" 5%"), null);
});

Deno.test("resolveMaxFailures: counts as given, percentages rounded down, none as null", () => {
  assertEquals(resolveMaxFailures(undefined, 10), null);
  assertEquals(resolveMaxFailures(3, 10), 3);
  assertEquals(resolveMaxFailures("10%", 10), 1);
  assertEquals(resolveMaxFailures("10%", 9), 0);
  assertEquals(resolveMaxFailures("25%", 8), 2);
  assertEquals(resolveMaxFailures("100%", 7), 7);
  assertEquals(resolveMaxFailures("0%", 7), 0);
  assertThrows(() => resolveMaxFailures("ten%", 7));
});

Deno.test("hasLane: only dispatch and waiting members get a lane", () => {
  const member = (
    disposition: "dispatch" | "waiting" | "skipped" | "failed" | "excluded",
  ) => ({
    worker: "w",
    instanceUuid: "u",
    disposition,
  });
  assertEquals(
    (["dispatch", "waiting", "skipped", "failed", "excluded"] as const).map((
      d,
    ) => hasLane(member(d))),
    [true, true, false, false, false],
  );
});
