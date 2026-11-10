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
import { TrustedHosts } from "./trusted_hosts.ts";

// Starts with a letter: URL parsing turns an all-digit name into an IPv4 address.
const ldhLabel = fc.stringMatching(/^[a-z]([a-z0-9-]{0,8}[a-z0-9])?$/);
// "--" at positions 3-4 is reserved: URL parsing refuses an xn-- label with bad punycode.
const label = ldhLabel.filter((l) => !/^..--/.test(l));
const hostName = fc.array(label, { minLength: 1, maxLength: 4 }).map((l) =>
  l.join(".")
);
const port = fc.integer({ min: 1, max: 65535 });

Deno.test("TrustedHosts: an entry accepts its own name on every port and no other name", () => {
  fc.assert(
    fc.property(
      hostName,
      fc.option(port, { nil: undefined }),
      port,
      hostName,
      (name, entryPort, requestPort, other) => {
        const entry = entryPort === undefined ? name : `${name}:${entryPort}`;
        const trusted = TrustedHosts.parse(entry);
        assertEquals(trusted.acceptsHost(name), true);
        assertEquals(trusted.acceptsHost(`${name}:${requestPort}`), true);
        assertEquals(trusted.acceptsHost(name.toUpperCase()), true);
        assertEquals(trusted.acceptsHost(`${name}.`), false);
        assertEquals(trusted.acceptsHost(`x${name}`), false);
        assertEquals(trusted.acceptsHost(`${name}.${other}`), false);
        if (other !== name) {
          assertEquals(trusted.acceptsHost(other), false);
        }
      },
    ),
  );
});
