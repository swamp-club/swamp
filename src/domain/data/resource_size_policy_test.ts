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

import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import {
  checkResourceSizeConfig,
  DEFAULT_RESOURCE_WARN_BYTES,
  formatByteSize,
  ResourceSizePolicy,
  ResourceTooLargeError,
} from "./resource_size_policy.ts";

Deno.test("ResourceSizePolicy.classify: warns past warnBytes and refuses nothing by default", () => {
  const policy = ResourceSizePolicy.DEFAULT;
  assertEquals(policy.classify(DEFAULT_RESOURCE_WARN_BYTES), "ok");
  assertEquals(policy.classify(DEFAULT_RESOURCE_WARN_BYTES + 1), "warn");
  assertEquals(policy.classify(Number.MAX_SAFE_INTEGER), "warn");
});

Deno.test("ResourceSizePolicy.classify: refuses past maxBytes", () => {
  const policy = ResourceSizePolicy.create({ warnBytes: 10, maxBytes: 20 });
  assertEquals(policy.classify(10), "ok");
  assertEquals(policy.classify(11), "warn");
  assertEquals(policy.classify(20), "warn");
  assertEquals(policy.classify(21), "refuse");
});

Deno.test("ResourceSizePolicy.create: rejects a maxBytes below warnBytes and non-byte counts", () => {
  assertThrows(
    () => ResourceSizePolicy.create({ warnBytes: 20, maxBytes: 10 }),
    RangeError,
  );
  assertThrows(() => ResourceSizePolicy.create({ warnBytes: 0 }), RangeError);
  assertThrows(() => ResourceSizePolicy.create({ warnBytes: 1.5 }), RangeError);
});

Deno.test("checkResourceSizeConfig: reads valid limits", () => {
  const { policy, ignored, unknownKeys } = checkResourceSizeConfig({
    warnBytes: 100,
    maxBytes: 200,
  });
  assertEquals([policy.warnBytes, policy.maxBytes], [100, 200]);
  assertEquals(ignored, []);
  assertEquals(unknownKeys, []);
});

Deno.test("checkResourceSizeConfig: ignores bad values and reports unknown keys", () => {
  const { policy, ignored, unknownKeys } = checkResourceSizeConfig({
    warnBytes: "big",
    maxBytes: -1,
    maxbytes: 5,
  });
  assertEquals(policy.warnBytes, DEFAULT_RESOURCE_WARN_BYTES);
  assertEquals(policy.maxBytes, undefined);
  assertEquals(ignored.length, 2);
  assertEquals(unknownKeys, ["maxbytes"]);
});

Deno.test("checkResourceSizeConfig: ignores a maxBytes below the effective warnBytes", () => {
  const { policy, ignored } = checkResourceSizeConfig({ maxBytes: 1024 });
  assertEquals(policy.maxBytes, undefined);
  assertStringIncludes(ignored[0], "must be at least resourceSize.warnBytes");
});

Deno.test("checkResourceSizeConfig: a non-mapping falls back to the defaults", () => {
  const { policy, ignored } = checkResourceSizeConfig([1, 2]);
  assertEquals(policy, ResourceSizePolicy.DEFAULT);
  assertEquals(ignored.length, 1);
  assertEquals(
    checkResourceSizeConfig(undefined).policy,
    ResourceSizePolicy.DEFAULT,
  );
});

Deno.test("formatByteSize: picks a binary unit", () => {
  assertEquals(formatByteSize(512), "512 B");
  assertEquals(formatByteSize(2048), "2.0 KiB");
  assertEquals(formatByteSize(419429501), "400.0 MiB");
  assertEquals(formatByteSize(5 * 1024 ** 3), "5.0 GiB");
});

Deno.test("ResourceTooLargeError: names the writer, the resource, its size and the config key", () => {
  const error = new ResourceTooLargeError(
    {
      modelType: "@repro/bigdata",
      definitionName: "big",
      methodName: "write",
      specName: "blob",
      name: "blob-0",
    },
    419429501,
    100 * 1024 * 1024,
  );
  assertStringIncludes(
    error.message,
    "resource blob/blob-0 written by big.write",
  );
  assertStringIncludes(error.message, "400.0 MiB (419429501 bytes)");
  assertStringIncludes(error.message, "resourceSize.maxBytes");
  assertEquals(error.code, "resource_too_large");
});
