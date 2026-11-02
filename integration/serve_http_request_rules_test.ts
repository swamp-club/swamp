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
import { fromFileUrl } from "@std/path";
import { FOLLOWER_READ_REQUESTS } from "../src/serve/follower_requests.ts";
import { HTTP_REQUEST_TYPES } from "../src/serve/protocol.ts";

const SERVE_COMMAND = fromFileUrl(
  new URL("../src/cli/commands/serve.ts", import.meta.url),
);

Deno.test("serve HTTP route rules: the route is dispatched after the no-auth host and Origin checks", async () => {
  const source = await Deno.readTextFile(SERVE_COMMAND);
  const trustCheck = source.indexOf("validateNoAuthApiRequest(");
  const route = source.indexOf("apiUrl.pathname === SERVE_REQUEST_PATH");
  assert(trustCheck !== -1, "validateNoAuthApiRequest call not found");
  assert(route !== -1, "SERVE_REQUEST_PATH dispatch not found");
  assert(
    trustCheck < route,
    "the HTTP request route must be dispatched after validateNoAuthApiRequest",
  );
});

Deno.test("serve HTTP route rules: every type the route answers is a read a fresh follower answers itself", () => {
  for (const type of HTTP_REQUEST_TYPES) {
    assert(
      FOLLOWER_READ_REQUESTS.has(type),
      `${type} is answered over HTTP but is not a follower read`,
    );
  }
});
