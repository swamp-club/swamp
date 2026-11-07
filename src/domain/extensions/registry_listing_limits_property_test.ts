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
import type {
  ExtensionContentMetadata,
  ExtractedModel,
} from "./extension_content.ts";
import {
  REGISTRY_LISTING_LIMITS,
  registryListingLimitBreaches,
} from "./registry_listing_limits.ts";

const L = REGISTRY_LISTING_LIMITS;

// lengths cluster around each limit so both sides of it are exercised
const around = (limit: number) =>
  fc.integer({ min: Math.max(0, limit - 2), max: limit + 2 });

const argument = {
  name: "a",
  type: "string",
  description: "",
  required: false,
};

const modelArb: fc.Arbitrary<ExtractedModel> = fc.record({
  globalArgs: around(L.globalArgumentsPerModel),
  methodArgs: fc.array(around(L.argumentsPerMethod), {
    minLength: L.methodsPerModel - 1,
    maxLength: L.methodsPerModel + 1,
  }),
  resources: around(L.resourcesPerModel),
  files: around(L.filesPerModel),
}).map(({ globalArgs, methodArgs, resources, files }) => ({
  fileName: "m.ts",
  type: "@acme/thing",
  version: "2026.11.06.1",
  globalArguments: Array(globalArgs).fill(argument),
  methods: methodArgs.map((n, i) => ({
    name: `m${i}`,
    description: "",
    arguments: Array(n).fill(argument),
  })),
  resources: Array(resources).fill({ key: "r", description: "", lifetime: "" }),
  files: Array(files).fill({ key: "f", description: "", contentType: "" }),
}));

function overLimitLists(metadata: ExtensionContentMetadata): string[] {
  const over: string[] = [];
  if (metadata.models.length > L.models) over.push("models");
  for (const m of metadata.models) {
    if (m.globalArguments.length > L.globalArgumentsPerModel) {
      over.push("globalArguments");
    }
    if (m.methods.length > L.methodsPerModel) over.push("methods");
    for (const method of m.methods) {
      if (method.arguments.length > L.argumentsPerMethod) {
        over.push("arguments");
      }
    }
    if (m.resources.length > L.resourcesPerModel) over.push("resources");
    if (m.files.length > L.filesPerModel) over.push("files");
  }
  return over;
}

Deno.test("registryListingLimitBreaches: breaches are exactly the lists longer than their limit", () => {
  fc.assert(
    fc.property(
      fc.array(modelArb, { minLength: 0, maxLength: 3 }),
      fc.integer({ min: L.models - 2, max: L.models + 2 }),
      (sampled, modelCount) => {
        const models = Array.from(
          { length: modelCount },
          (_, i) => sampled[i % Math.max(1, sampled.length)],
        ).filter((m) => m !== undefined);
        const metadata: ExtensionContentMetadata = {
          models,
          extensions: [],
          workflows: [],
          vaults: [],
          datastores: [],
          reports: [],
          webhooks: [],
          skills: [],
        };
        const breaches = registryListingLimitBreaches(metadata);
        assertEquals(
          breaches.map((b) => b.list).sort(),
          overLimitLists(metadata).sort(),
        );
        for (const b of breaches) {
          assertEquals(b.count > b.limit, true);
        }
      },
    ),
    { numRuns: 50 },
  );
});
