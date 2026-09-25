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

import { assertEquals, assertStringIncludes } from "@std/assert";
import { withMockedFetch } from "@swamp-club/swamp-testing";
import { createExtensionRegistryLookup } from "./extension_registry_lookup.ts";

const SERVER_URL = "https://registry.example.test";

function header(headers: Record<string, string>, name: string): string {
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name);
  return key ? headers[key] : "";
}

Deno.test("createExtensionRegistryLookup: getExtension forwards the name and bearer token", async () => {
  const lookup = createExtensionRegistryLookup(SERVER_URL, {
    bearerToken: "token-123",
  });

  const { result, calls } = await withMockedFetch(
    [new Response(null, { status: 404 })],
    () => lookup.getExtension("@acme/store"),
  );

  assertEquals(result, null);
  assertEquals(calls.length, 1);
  assertStringIncludes(calls[0].url, "/api/v1/extensions/%40acme%2Fstore");
  assertStringIncludes(header(calls[0].headers, "authorization"), "token-123");
});

Deno.test("createExtensionRegistryLookup: searchExtensions forwards the search params", async () => {
  const lookup = createExtensionRegistryLookup(SERVER_URL, {
    bearerToken: "token-123",
  });

  const { result, calls } = await withMockedFetch(
    [Response.json({ extensions: [{ name: "@acme/postgres-datastore" }] })],
    () => lookup.searchExtensions({ q: "pg", collective: "acme" }),
  );

  assertEquals(result.extensions.map((e) => e.name), [
    "@acme/postgres-datastore",
  ]);
  const url = new URL(calls[0].url);
  assertEquals(url.pathname, "/api/v1/extensions/search");
  assertEquals(url.searchParams.get("q"), "pg");
  assertEquals(url.searchParams.get("collective"), "acme");
  assertStringIncludes(header(calls[0].headers, "authorization"), "token-123");
});
