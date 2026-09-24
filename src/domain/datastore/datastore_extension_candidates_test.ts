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
import { datastoreExtensionCandidates } from "./datastore_extension_candidates.ts";
import type { ExtensionLookupPort } from "../extensions/extension_auto_resolver.ts";

function lookup(
  known: string[],
  searchHit: string | null = null,
): ExtensionLookupPort {
  return {
    getExtension: (name) =>
      Promise.resolve(
        known.includes(name)
          ? { name, description: "", latestVersion: "1" }
          : null,
      ),
    searchExtensions: () =>
      Promise.resolve({
        extensions: searchHit ? [{ name: searchHit }] : [],
      }),
  };
}

Deno.test("datastoreExtensionCandidates: maps legacy s3 to the extension name", async () => {
  assertEquals(await datastoreExtensionCandidates("s3"), [
    "@swamp/s3-datastore",
  ]);
});

Deno.test("datastoreExtensionCandidates: static candidates are the type and its prefixes", async () => {
  assertEquals(await datastoreExtensionCandidates("@acme/pg/store"), [
    "@acme/pg/store",
    "@acme/pg",
  ]);
});

Deno.test("datastoreExtensionCandidates: filesystem and bare types have no candidates", async () => {
  assertEquals(await datastoreExtensionCandidates("filesystem"), []);
});

Deno.test("datastoreExtensionCandidates: adds the extension found by search", async () => {
  assertEquals(
    await datastoreExtensionCandidates(
      "@acme/pg",
      lookup([], "@acme/postgres-datastore"),
    ),
    ["@acme/pg", "@acme/postgres-datastore"],
  );
});

Deno.test("datastoreExtensionCandidates: does not duplicate a direct hit", async () => {
  assertEquals(
    await datastoreExtensionCandidates(
      "@swamp/s3-datastore",
      lookup(["@swamp/s3-datastore"]),
    ),
    ["@swamp/s3-datastore"],
  );
});

Deno.test("datastoreExtensionCandidates: a lookup failure keeps the static candidates", async () => {
  const failing: ExtensionLookupPort = {
    getExtension: () => Promise.reject(new TypeError("offline")),
    searchExtensions: () => Promise.reject(new TypeError("offline")),
  };
  assertEquals(await datastoreExtensionCandidates("@acme/pg", failing), [
    "@acme/pg",
  ]);
});
