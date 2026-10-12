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
import { ExtensionReplacement } from "./extension_replacement.ts";

const arbCalVer = fc.tuple(
  fc.integer({ min: 2020, max: 2030 }),
  fc.integer({ min: 1, max: 12 }),
  fc.integer({ min: 1, max: 28 }),
  fc.integer({ min: 1, max: 30 }),
).map(([y, m, d, n]) =>
  `${y}.${String(m).padStart(2, "0")}.${String(d).padStart(2, "0")}.${n}`
);
const arbChannel = fc.constantFrom("stable", "rc", "beta");

const MIRROR = { upgrade: "downgrade", downgrade: "upgrade", same: "same" };

Deno.test("ExtensionReplacement.create: swapping the sides mirrors the change", () => {
  fc.assert(
    fc.property(
      arbCalVer,
      arbCalVer,
      arbChannel,
      arbChannel,
      (a, b, chA, chB) => {
        const forward = ExtensionReplacement.create({
          name: "@a/b",
          current: { version: a, channel: chA, publishedChannel: chA },
          incoming: { version: b, channel: chB, publishedChannel: chB },
        });
        const backward = ExtensionReplacement.create({
          name: "@a/b",
          current: { version: b, channel: chB, publishedChannel: chB },
          incoming: { version: a, channel: chA, publishedChannel: chA },
        });
        assertEquals(
          backward.change,
          MIRROR[forward.change as keyof typeof MIRROR],
        );
        assertEquals(forward.change === "same", a === b);
        assertEquals(forward.channelChanged, backward.channelChanged);
        assertEquals(forward.channelChanged, chA !== chB);
      },
    ),
  );
});
