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
import { extractExtensionNameFromPath } from "./extension_loader.ts";

Deno.test("extractExtensionNameFromPath: scoped extension name", () => {
  const result = extractExtensionNameFromPath(
    "/repo/.swamp/pulled-extensions/@testco/greeter/models/greeter/model.ts",
    "/repo",
  );
  assertEquals(result, "@testco/greeter");
});

Deno.test("extractExtensionNameFromPath: unscoped extension name", () => {
  const result = extractExtensionNameFromPath(
    "/repo/.swamp/pulled-extensions/myext/models/greeter/model.ts",
    "/repo",
  );
  assertEquals(result, "myext");
});

Deno.test("extractExtensionNameFromPath: user-authored model (not in pulled-extensions)", () => {
  const result = extractExtensionNameFromPath(
    "/repo/extensions/models/greeter/model.ts",
    "/repo",
  );
  assertEquals(result, undefined);
});

Deno.test("extractExtensionNameFromPath: null repoDir", () => {
  const result = extractExtensionNameFromPath(
    "/repo/.swamp/pulled-extensions/@testco/greeter/models/model.ts",
    null,
  );
  assertEquals(result, undefined);
});

Deno.test("extractExtensionNameFromPath: rejects path traversal in segments", () => {
  const result = extractExtensionNameFromPath(
    "/repo/.swamp/pulled-extensions/../../../etc/models/model.ts",
    "/repo",
  );
  assertEquals(result, undefined);
});

Deno.test("extractExtensionNameFromPath: rejects null bytes in name", () => {
  const result = extractExtensionNameFromPath(
    "/repo/.swamp/pulled-extensions/evil\0name/models/model.ts",
    "/repo",
  );
  assertEquals(result, undefined);
});

Deno.test("extractExtensionNameFromPath: path too short", () => {
  const result = extractExtensionNameFromPath(
    "/repo/.swamp/pulled-extensions/only-one-segment",
    "/repo",
  );
  assertEquals(result, undefined);
});

Deno.test("extractExtensionNameFromPath: deeply nested scoped path", () => {
  const result = extractExtensionNameFromPath(
    "/repo/.swamp/pulled-extensions/@swamp/aws/ec2/models/instance/model.ts",
    "/repo",
  );
  assertEquals(result, "@swamp/aws");
});
