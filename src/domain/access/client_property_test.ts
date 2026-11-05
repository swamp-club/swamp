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
import {
  CLIENT_KINDS,
  clientToString,
  DIRECT_CLIENT_IDS,
  parseClient,
} from "./client.ts";

const validClient = fc.oneof(
  fc.constantFrom(...DIRECT_CLIENT_IDS).map((id) => `direct:${id}`),
  fc.stringMatching(/^[a-z0-9][a-z0-9-]{0,62}$/).map((id) =>
    `integration:${id}`
  ),
);

Deno.test("parseClient: every valid value round-trips", () => {
  fc.assert(fc.property(validClient, (value) => {
    assertEquals(clientToString(parseClient(value)), value);
  }));
});

Deno.test("parseClient: whatever it accepts has a known kind and round-trips", () => {
  fc.assert(fc.property(fc.string(), fc.string(), (kind, id) => {
    const value = `${kind}:${id}`;
    let parsed;
    try {
      parsed = parseClient(value);
    } catch {
      return;
    }
    assert((CLIENT_KINDS as readonly string[]).includes(parsed.kind));
    assertEquals(clientToString(parsed), value);
  }));
});
