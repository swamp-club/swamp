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
import { dataPlaneUrlFromConnectUrl } from "./data_plane_client.ts";

const arbSegment = fc.oneof(
  fc.constantFrom("w", "x", "ws", "swamp", "a:b", "%2F", "..", "."),
  fc.stringMatching(/^[A-Za-z0-9._~-]{1,8}$/),
);
const arbPath = fc.array(arbSegment, { maxLength: 5 }).chain((segments) =>
  fc.boolean().map((slash) =>
    `/${segments.join("/")}${slash && segments.length > 0 ? "/" : ""}`
  )
);
const arbServed = fc.oneof(
  fc.constant(undefined),
  arbPath,
  fc.string({ maxLength: 20 }),
);

Deno.test("dataPlaneUrlFromConnectUrl: a reported path can only shorten the connect path", () => {
  fc.assert(
    fc.property(
      fc.constantFrom("ws://h:9090", "wss://orch.internal"),
      arbPath,
      arbServed,
      (origin, path, served) => {
        const connect = new URL(`${origin}${path}`);
        const derived = new URL(
          dataPlaneUrlFromConnectUrl(connect.href, served),
        );
        assertEquals(derived.host, connect.host);
        assertEquals(
          derived.protocol,
          connect.protocol === "wss:" ? "https:" : "http:",
        );
        assertEquals(derived.search, "");
        assert(derived.pathname.endsWith("/"));
        assert(
          `${connect.pathname.replace(/\/+$/, "")}/`.startsWith(
            derived.pathname,
          ),
          `${derived.pathname} is not a prefix of ${connect.pathname}`,
        );
      },
    ),
  );
});
