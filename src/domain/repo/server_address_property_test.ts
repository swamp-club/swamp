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

import { assert, assertThrows } from "@std/assert";
import fc from "fast-check";
import { UserError } from "../errors.ts";
import { assertStorableServerAddress } from "./server_address.ts";

const arbScheme = fc.constantFrom("http", "https", "ws", "wss");

const arbHost = fc.constantFrom(
  "example.com",
  "Example.COM",
  "localhost",
  "sub.domain.io",
  "127.0.0.1",
);

const arbSegment = fc.stringOf(
  fc.constantFrom(..."abcdefgh0123-_".split("")),
  { minLength: 1, maxLength: 8 },
);

const arbBase = fc
  .record({
    scheme: arbScheme,
    host: arbHost,
    port: fc.option(fc.integer({ min: 1, max: 65535 }), { nil: undefined }),
    segments: fc.array(arbSegment, { maxLength: 3 }),
  })
  .map(({ scheme, host, port, segments }) => ({
    prefix: `${scheme}://`,
    rest: `${host}${port === undefined ? "" : `:${port}`}${
      segments.length > 0 ? `/${segments.join("/")}` : ""
    }`,
  }));

// The "zz9" marker never appears in a generated host or path (their
// alphabets exclude "z"), so a secret found in the message really leaked.
const arbSecret = fc
  .stringOf(fc.constantFrom(..."XYZ789".split("")), {
    minLength: 1,
    maxLength: 12,
  })
  .map((s) => `zz9${s}`);

const arbPlacement = fc.constantFrom("password", "token", "fragment");

Deno.test("assertStorableServerAddress: accepts any credential-free http(s)/ws(s) URL", () => {
  fc.assert(
    fc.property(arbBase, ({ prefix, rest }) => {
      assertStorableServerAddress(`${prefix}${rest}`);
    }),
    { numRuns: 300 },
  );
});

Deno.test("assertStorableServerAddress: refuses a secret anywhere and never echoes it", () => {
  fc.assert(
    fc.property(
      arbBase,
      arbSecret,
      arbPlacement,
      ({ prefix, rest }, secret, placement) => {
        const value = placement === "password"
          ? `${prefix}user:${secret}@${rest}`
          : placement === "token"
          ? `${prefix}${rest}?token=${secret}`
          : `${prefix}${rest}#${secret}`;
        const error = assertThrows(
          () => assertStorableServerAddress(value),
          UserError,
        );
        assert(!error.message.includes(secret), error.message);
      },
    ),
    { numRuns: 300 },
  );
});
