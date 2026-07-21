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

import { assertEquals, assertRejects } from "@std/assert";
import {
  clearAttachedExtensions,
  modelKindAdapter,
  removeAttachedExtensionsForType,
} from "./model_kind_adapter.ts";

Deno.test("removeAttachedExtensionsForType: does not throw for unknown type", () => {
  removeAttachedExtensionsForType("@nonexistent/type");
});

Deno.test("removeAttachedExtensionsForType: clears only the targeted type", () => {
  clearAttachedExtensions();
  removeAttachedExtensionsForType("@test/alpha");
  removeAttachedExtensionsForType("@test/beta");
});

Deno.test("extractTypeFromSource: standalone model returns kind=model", () => {
  const source = `
import { z } from "npm:zod";
export const model = {
  type: "@test/greeter",
  version: "2026.01.01.0",
};`;
  const result = modelKindAdapter.extractTypeFromSource(source);
  assertEquals(result?.kind, "model");
  assertEquals(result?.extendsType, "");
});

Deno.test("extractTypeFromSource: extension returns kind=extension", () => {
  const source = `
import { z } from "npm:zod";
export const extension = {
  type: "@test/greeter",
};`;
  const result = modelKindAdapter.extractTypeFromSource(source);
  assertEquals(result?.kind, "extension");
  assertEquals(result?.extendsType, "@test/greeter");
});

Deno.test("extractTypeFromSource: model with 'export const extension' in comment returns kind=model", () => {
  const source = `
import { z } from "npm:zod";
// NOTE: use export const extension = {...} to extend an existing type
export const model = {
  type: "@test/greeter",
  version: "2026.01.01.0",
};`;
  const result = modelKindAdapter.extractTypeFromSource(source);
  assertEquals(result?.kind, "model");
  assertEquals(result?.extendsType, "");
});

Deno.test("extractTypeFromSource: model with 'export const extension' in string returns kind=model", () => {
  const source = `
import { z } from "npm:zod";
export const model = {
  type: "@test/greeter",
  version: "2026.01.01.0",
  methods: {
    greet: {
      description: "Use export const extension = {...} to extend types.",
    },
  },
};`;
  const result = modelKindAdapter.extractTypeFromSource(source);
  assertEquals(result?.kind, "model");
  assertEquals(result?.extendsType, "");
});

Deno.test("importAndExtendBundle: skips standalone model bundle without throwing", async () => {
  const entry = {
    source_path: "/tmp/fake/model.ts",
    type_normalized: "@test/greeter",
    kind: "extension" as const,
    bundle_path: "/tmp/fake/model.js",
    version: "1.0.0",
    description: "",
    extends_type: "@test/greeter",
    source_mtime: "",
    source_fingerprint: "",
  };
  const result = {
    loaded: [] as string[],
    extended: [] as string[],
    failed: [] as { file: string; error: string }[],
  };
  await modelKindAdapter.importAndExtendBundle!(
    entry,
    () => Promise.resolve({ model: { type: "@test/greeter" } }),
    result,
  );
  assertEquals(result.extended.length, 0);
  assertEquals(result.failed.length, 0);
});

Deno.test("importAndExtendBundle: throws for bundle with neither model nor extension export", async () => {
  const entry = {
    source_path: "/tmp/fake/broken.ts",
    type_normalized: "@test/broken",
    kind: "extension" as const,
    bundle_path: "/tmp/fake/broken.js",
    version: "1.0.0",
    description: "",
    extends_type: "@test/broken",
    source_mtime: "",
    source_fingerprint: "",
  };
  const result = {
    loaded: [] as string[],
    extended: [] as string[],
    failed: [] as { file: string; error: string }[],
  };
  await assertRejects(
    () =>
      modelKindAdapter.importAndExtendBundle!(
        entry,
        () => Promise.resolve({ helper: true }),
        result,
      ),
    Error,
    "Bundle has no extension export",
  );
});
