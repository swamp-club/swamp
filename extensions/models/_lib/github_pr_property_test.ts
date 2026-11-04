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

import { assert, assertEquals } from "@std/assert";
import fc from "fast-check";
import { classifyPrSnapshot, type PrSnapshot } from "./github_pr.ts";

const snapshotArb: fc.Arbitrary<PrSnapshot> = fc.record({
  state: fc.constantFrom("OPEN", "CLOSED", "MERGED"),
  mergeable: fc.constantFrom("MERGEABLE", "CONFLICTING", "UNKNOWN"),
  mergeStateStatus: fc.constantFrom(
    "CLEAN",
    "BLOCKED",
    "BEHIND",
    "DIRTY",
    "UNKNOWN",
    "UNSTABLE",
  ),
  reviewDecision: fc.constantFrom(
    "",
    "APPROVED",
    "CHANGES_REQUESTED",
    "REVIEW_REQUIRED",
  ),
  labels: fc.array(fc.constantFrom("hold", "bug", "wip")),
  failedChecks: fc.array(fc.constantFrom("lint", "test")),
});

const HOLD = ["hold"];

Deno.test("classifyPrSnapshot: a merged PR is merged whatever else it reports", () => {
  fc.assert(
    fc.property(snapshotArb, (s) => {
      assertEquals(
        classifyPrSnapshot({ ...s, state: "MERGED" }, HOLD).outcome,
        "merged",
      );
    }),
  );
});

Deno.test("classifyPrSnapshot: on an open PR a conflict outranks checks, review and hold", () => {
  fc.assert(
    fc.property(snapshotArb, (s) => {
      assertEquals(
        classifyPrSnapshot(
          { ...s, state: "OPEN", mergeable: "CONFLICTING" },
          HOLD,
        ).outcome,
        "conflict",
      );
    }),
  );
});

Deno.test("classifyPrSnapshot: an open PR with nothing wrong is never terminal", () => {
  fc.assert(
    fc.property(snapshotArb, (s) => {
      const clean: PrSnapshot = {
        ...s,
        state: "OPEN",
        mergeable: s.mergeable === "CONFLICTING" ? "UNKNOWN" : s.mergeable,
        mergeStateStatus: s.mergeStateStatus === "DIRTY"
          ? "UNKNOWN"
          : s.mergeStateStatus,
        reviewDecision: s.reviewDecision === "CHANGES_REQUESTED"
          ? ""
          : s.reviewDecision,
        labels: s.labels.filter((l) => !HOLD.includes(l)),
        failedChecks: [],
      };
      assertEquals(classifyPrSnapshot(clean, HOLD).outcome, "pending");
    }),
  );
});

Deno.test("classifyPrSnapshot: every terminal verdict carries a reason", () => {
  fc.assert(
    fc.property(snapshotArb, (s) => {
      const verdict = classifyPrSnapshot(s, HOLD);
      if (verdict.outcome !== "pending") assert(verdict.reason.length > 0);
    }),
  );
});
