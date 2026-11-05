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
import { fromFileUrl } from "@std/path";
import { resolveHttpRoute } from "../src/serve/http_request_span.ts";
import { SERVE_REQUEST_PATH } from "../src/serve/protocol.ts";

const SERVE_COMMAND = fromFileUrl(
  new URL("../src/cli/commands/serve.ts", import.meta.url),
);

// A route compared through a constant in serve.ts must be listed here.
const ROUTE_CONSTANTS: Readonly<Record<string, string>> = {
  SERVE_REQUEST_PATH,
};

const LITERAL_ROUTE = /===\s*"(\/[^"]*)"/g;
const CONSTANT_ROUTE =
  /(?:\.pathname|\b\w*Path|\bpath)\s*===\s*([A-Z][A-Z0-9_]*)\b/g;

// Floors at the current counts, so a scan that stops matching fails loudly.
const MIN_LITERAL_ROUTES = 15;
const MIN_CONSTANT_ROUTES = 1;

const SCAN_LIMIT = "The scan sees only === comparisons; a route matched by " +
  "switch/case, !==, startsWith or a Set lookup is not checked.";

Deno.test("serve HTTP route span rules: every fixed path the handler compares against has a span route", async () => {
  const source = await Deno.readTextFile(SERVE_COMMAND);

  const literals = [...source.matchAll(LITERAL_ROUTE)].map((m) => m[1]);
  const constants = [...source.matchAll(CONSTANT_ROUTE)].map((m) => m[1]);

  assert(
    literals.length >= MIN_LITERAL_ROUTES,
    `found ${literals.length} literal route comparisons in serve.ts, ` +
      `expected at least ${MIN_LITERAL_ROUTES}. ${SCAN_LIMIT}`,
  );
  assert(
    constants.length >= MIN_CONSTANT_ROUTES,
    `found ${constants.length} constant route comparisons in serve.ts, ` +
      `expected at least ${MIN_CONSTANT_ROUTES}. ${SCAN_LIMIT}`,
  );

  const paths = [...literals];
  for (const name of constants) {
    const value = ROUTE_CONSTANTS[name];
    assert(
      value !== undefined,
      `serve.ts compares a path against ${name}; add it to ROUTE_CONSTANTS ` +
        `in this test so its span route is checked`,
    );
    paths.push(value);
  }

  for (const path of new Set(paths)) {
    assertEquals(
      resolveHttpRoute(path),
      path,
      `serve.ts answers ${path} but resolveHttpRoute gives it no route; ` +
        `add it to EXACT_ROUTES in src/serve/http_request_span.ts`,
    );
  }
});
