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
import { defineCreek, defineCreekMethod } from "../creek.ts";

/**
 * Built-in trivial creek that exists primarily as a smoke fixture for
 * integration tests and a discoverable starting point for new authors.
 *
 * Has no external dependencies — every method is pure and synchronous —
 * which makes it useful for asserting things like "the cross-query CEL
 * function is wired up at all" without needing network or a mock server.
 */
export const echoCreek = defineCreek({
  type: "@swamp/echo-creek",
  version: "2026.06.01.1",
  description: "Trivial creek used for testing and smoke checks.",
  methods: {
    echo: defineCreekMethod({
      description: "Returns its argument unchanged.",
      arguments: z.object({ value: z.string() }),
      returns: z.string(),
      execute: (args) => Promise.resolve(args.value),
    }),
    now: defineCreekMethod({
      description: "Returns the current ISO timestamp.",
      arguments: z.object({}),
      returns: z.string(),
      execute: () => Promise.resolve(new Date().toISOString()),
    }),
    concat: defineCreekMethod({
      description: "Concatenates two strings.",
      arguments: z.object({ a: z.string(), b: z.string() }),
      returns: z.string(),
      execute: (args) => Promise.resolve(args.a + args.b),
    }),
  },
});
