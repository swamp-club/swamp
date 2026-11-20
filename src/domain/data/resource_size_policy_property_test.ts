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
import { ResourceSizePolicy } from "./resource_size_policy.ts";

const limits = fc.tuple(
  fc.integer({ min: 1, max: 2 ** 40 }),
  fc.option(fc.integer({ min: 0, max: 2 ** 40 }), { nil: undefined }),
).map(([warnBytes, extra]) => ({
  warnBytes,
  maxBytes: extra === undefined ? undefined : warnBytes + extra,
}));

const rank = { ok: 0, warn: 1, refuse: 2 } as const;

Deno.test("ResourceSizePolicy.classify: never lessens as bytes grow", () => {
  fc.assert(
    fc.property(
      limits,
      fc.integer({ min: 0, max: 2 ** 41 }),
      fc.integer({ min: 0, max: 2 ** 41 }),
      (l, a, b) => {
        const policy = ResourceSizePolicy.create(l);
        const [lo, hi] = a <= b ? [a, b] : [b, a];
        return rank[policy.classify(lo)] <= rank[policy.classify(hi)];
      },
    ),
  );
});

Deno.test("ResourceSizePolicy.classify: a refused size is also past the warning threshold", () => {
  fc.assert(
    fc.property(limits, fc.integer({ min: 0, max: 2 ** 41 }), (l, bytes) => {
      const policy = ResourceSizePolicy.create(l);
      if (policy.classify(bytes) !== "refuse") return true;
      assert(bytes > policy.warnBytes);
      return policy.maxBytes !== undefined;
    }),
  );
});
