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
import {
  type ExtensionTreeIndex,
  fromStoredArchiveIndex,
  runtimeContentTypes,
  toStoredArchiveIndex,
} from "./extension_tree_index.ts";

const INDEX: ExtensionTreeIndex = {
  sources: [
    {
      kindDir: "models",
      absolutePath: "/x/models/a.ts",
      fileName: "a.ts",
      indexed: {
        kind: "model",
        typeNormalized: "@acme/a",
        bundlePath: "/b/a.js",
        fingerprint: "f1",
        fromCache: false,
      },
    },
    {
      kindDir: "models",
      absolutePath: "/x/models/helper.ts",
      fileName: "helper.ts",
      indexed: null,
    },
    {
      kindDir: "models",
      absolutePath: "/x/models/ext.ts",
      fileName: "ext.ts",
      indexed: {
        kind: "extension",
        typeNormalized: "@other/base",
        bundlePath: "/b/ext.js",
        fingerprint: "f2",
        fromCache: false,
      },
    },
    {
      kindDir: "vaults",
      absolutePath: "/x/vaults/v.ts",
      fileName: "v.ts",
      indexed: {
        kind: "vault",
        typeNormalized: "@acme/v",
        bundlePath: "/b/v.js",
        fingerprint: "f3",
        fromCache: false,
      },
    },
  ],
  failures: [{
    kindDir: "models",
    absolutePath: "/x/models/broken.ts",
    fileName: "broken.ts",
    reason: "boom",
  }],
};

Deno.test("runtimeContentTypes: lists the types loaded sources register, leaving out helpers and extension sources", () => {
  assertEquals(runtimeContentTypes(INDEX), [
    { kind: "model", typeNormalized: "@acme/a", fileName: "a.ts" },
    { kind: "vault", typeNormalized: "@acme/v", fileName: "v.ts" },
  ]);
});

Deno.test("toStoredArchiveIndex/fromStoredArchiveIndex: a stored index gives back the same types and failures (swamp-club#3456)", () => {
  const restored = fromStoredArchiveIndex(toStoredArchiveIndex(INDEX));
  assertEquals(
    restored && runtimeContentTypes(restored),
    runtimeContentTypes(INDEX),
  );
  assertEquals(
    restored?.failures.map((f) => [f.kindDir, f.fileName, f.reason]),
    [["models", "broken.ts", "boom"]],
  );
  assertEquals(
    restored?.sources.map((s) => [s.kindDir, s.fileName, s.indexed?.kind]),
    [
      ["models", "a.ts", "model"],
      ["models", "ext.ts", "extension"],
      ["vaults", "v.ts", "vault"],
    ],
  );
});

Deno.test("fromStoredArchiveIndex: a stored kind or directory this version does not know drops the whole index (swamp-club#3456)", () => {
  const stored = toStoredArchiveIndex(INDEX);
  assertEquals(
    fromStoredArchiveIndex({
      ...stored,
      sources: [{ ...stored.sources[0], kind: "workflow" }],
    }),
    undefined,
  );
  assertEquals(
    fromStoredArchiveIndex({
      ...stored,
      sources: [{ ...stored.sources[0], kindDir: "../models" }],
    }),
    undefined,
  );
  assertEquals(
    fromStoredArchiveIndex({
      ...stored,
      failures: [{ kindDir: "skills", fileName: "x.ts", reason: "r" }],
    }),
    undefined,
  );
});
