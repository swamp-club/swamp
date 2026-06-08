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
import { z } from "zod";
import { creekKindAdapter } from "./creek_kind_adapter.ts";

Deno.test("creekKindAdapter: validates a well-formed creek export", () => {
  const exported = {
    type: "@me/jira",
    version: "2026.06.01.1",
    description: "Jira",
    methods: {
      issue: {
        description: "Fetch an issue",
        arguments: z.object({ key: z.string() }),
        execute: () => Promise.resolve(null),
      },
    },
  };

  const result = creekKindAdapter.validatePrimaryExport(exported);
  assert(result.success);
});

Deno.test("creekKindAdapter: rejects unscoped types", () => {
  const result = creekKindAdapter.validatePrimaryExport({
    type: "no_slash_here",
    version: "2026.06.01.1",
    methods: {
      a: {
        description: "",
        arguments: z.object({}),
        execute: () => Promise.resolve(null),
      },
    },
  });
  assert(!result.success);
});

Deno.test("creekKindAdapter: rejects creeks with zero methods", () => {
  const result = creekKindAdapter.validatePrimaryExport({
    type: "@me/empty",
    version: "2026.06.01.1",
    methods: {},
  });
  assert(!result.success);
});

Deno.test("creekKindAdapter: rejects when arguments is not a Zod schema", () => {
  const result = creekKindAdapter.validatePrimaryExport({
    type: "@me/bad",
    version: "2026.06.01.1",
    methods: {
      a: {
        description: "",
        arguments: { not: "a schema" },
        execute: () => Promise.resolve(null),
      },
    },
  });
  assert(!result.success);
});

Deno.test("creekKindAdapter: extractTypeFromSource picks up type + version", () => {
  const source = `
    import { z } from "zod";
    export const creek = {
      type: "@me/jira",
      version: "2026.06.01.1",
      methods: {},
    };
  `;
  const extracted = creekKindAdapter.extractTypeFromSource(source);
  assert(extracted !== null);
  assertEquals(extracted.typeNormalized, "@me/jira");
  assertEquals(extracted.version, "2026.06.01.1");
  assertEquals(extracted.kind, "creek");
});

Deno.test("creekKindAdapter: extractTypeFromSource returns null when no creek export", () => {
  const source = `export const datastore = { type: "@me/foo" };`;
  assertEquals(creekKindAdapter.extractTypeFromSource(source), null);
});

Deno.test("creekKindAdapter: normalizeType lowercases the type", () => {
  const normalized = creekKindAdapter.normalizeType({
    type: "@Me/JIRA",
  });
  assertEquals(normalized, "@me/jira");
});

Deno.test("creekKindAdapter: kind metadata", () => {
  assertEquals(creekKindAdapter.kind, "creek");
  assertEquals(creekKindAdapter.primaryExportKey, "creek");
  assertEquals(creekKindAdapter.bundleSubdir, "creek-bundles");
  assertEquals(creekKindAdapter.useResolver, false);
});
