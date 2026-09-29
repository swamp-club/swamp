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

import { assertEquals } from "@std/assert";
import fc from "fast-check";
import {
  type ForwardStatus,
  STATUS_ORDER,
  statusPath,
} from "./issue_status.ts";

const ALL_STATUSES = [...STATUS_ORDER, "closed"] as const;

/** The status swamp-club requires an issue to hold before each transition. */
const REQUIRES: Record<ForwardStatus, string> = {
  open: "closed",
  triaged: "open",
  in_progress: "triaged",
  shipped: "in_progress",
};

const rank = (status: string) => STATUS_ORDER.indexOf(status as ForwardStatus);

Deno.test("statusPath: every step is one swamp-club accepts from the status before it", () => {
  fc.assert(
    fc.property(
      fc.constantFrom(...ALL_STATUSES),
      fc.constantFrom(...STATUS_ORDER),
      (current, target) => {
        let status: string = current;
        for (const step of statusPath(current, target)) {
          assertEquals(REQUIRES[step], status);
          status = step;
        }
      },
    ),
  );
});

Deno.test("statusPath: lands on the target, or leaves an issue that is already past it", () => {
  fc.assert(
    fc.property(
      fc.constantFrom(...ALL_STATUSES),
      fc.constantFrom(...STATUS_ORDER),
      (current, target) => {
        const path = statusPath(current, target);
        const alreadyThere = current !== "closed" &&
          rank(current) >= rank(target);
        if (alreadyThere) {
          assertEquals(path, []);
        } else {
          assertEquals(path[path.length - 1], target);
        }
      },
    ),
  );
});

Deno.test("statusPath: walking again from where a walk ended is a no-op", () => {
  fc.assert(
    fc.property(
      fc.constantFrom(...ALL_STATUSES),
      fc.constantFrom(...STATUS_ORDER),
      (current, target) => {
        const path = statusPath(current, target);
        const reached = path.length ? path[path.length - 1] : current;
        if (reached !== "closed") assertEquals(statusPath(reached, target), []);
      },
    ),
  );
});
