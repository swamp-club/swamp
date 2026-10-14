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

// The behaviors: manifest key, the behavior spelling of models:
// (swamp-club#3338).

import { assertEquals, assertThrows } from "@std/assert";
import fc from "fast-check";
import { parseExtensionManifest } from "./extension_manifest.ts";

const base = {
  manifestVersion: 1,
  name: "@acme/spelled",
  version: "2026.05.01.1",
};

Deno.test("parseExtensionManifest: behaviors: parses exactly as models:, marked with its key", () => {
  fc.assert(
    fc.property(
      fc.array(
        fc.stringMatching(
          /^[a-z][a-z0-9_]{0,8}(\/[a-z][a-z0-9_]{0,8}){0,2}\.ts$/,
        ),
        { minLength: 1, maxLength: 5 },
      ),
      (entries) => {
        const asModels = parseExtensionManifest(
          JSON.stringify({ ...base, models: entries }),
        );
        const asBehaviors = parseExtensionManifest(
          JSON.stringify({ ...base, behaviors: entries }),
        );
        assertEquals(asModels.modelsKey, undefined);
        assertEquals("modelsKey" in asModels, false);
        assertEquals(asBehaviors.modelsKey, "behaviors");
        const { modelsKey: _key, ...rest } = asBehaviors;
        assertEquals(rest, asModels);
      },
    ),
  );
});

Deno.test("parseExtensionManifest: behaviors: alone satisfies the at-least-one-entry rule", () => {
  const manifest = parseExtensionManifest(
    JSON.stringify({ ...base, behaviors: ["thing.ts"] }),
  );
  assertEquals(manifest.models, ["thing.ts"]);
});

Deno.test("parseExtensionManifest: a manifest with models: reads exactly as before, ignoring a stray behaviors: key", () => {
  // Before behaviors: existed, the key was dropped beside models:; it still
  // is, so no manifest that parsed before parses differently now.
  for (
    const [withStray, without] of [
      [{ models: ["a.ts"], behaviors: ["b.ts"] }, { models: ["a.ts"] }],
      [{ models: ["a.ts"], behaviors: [] }, { models: ["a.ts"] }],
    ] as const
  ) {
    assertEquals(
      parseExtensionManifest(JSON.stringify({ ...base, ...withStray })),
      parseExtensionManifest(JSON.stringify({ ...base, ...without })),
    );
  }
  // An empty models: list still needs some other entry point, as before.
  assertThrows(() =>
    parseExtensionManifest(
      JSON.stringify({ ...base, models: [], behaviors: ["b.ts"] }),
    )
  );
});

Deno.test("parseExtensionManifest: behaviors: entries get the same path safety check as models:", () => {
  assertThrows(
    () =>
      parseExtensionManifest(
        JSON.stringify({ ...base, behaviors: ["../escape.ts"] }),
      ),
    Error,
    "behaviors",
  );
});

Deno.test("parseExtensionManifest: only the exact behaviors key is a synonym", () => {
  for (const key of ["behaviours", "behavior", "Behaviors"]) {
    assertThrows(
      () =>
        parseExtensionManifest(JSON.stringify({ ...base, [key]: ["a.ts"] })),
      Error,
      "at least one behavior",
    );
  }
});
