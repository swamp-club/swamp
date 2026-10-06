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

import { assertEquals, assertThrows } from "@std/assert";
import { UserError } from "../../domain/errors.ts";
import {
  resolvePromoteTarget,
  withExtensionNameHint,
} from "./extension_promote.ts";

Deno.test("resolvePromoteTarget: a scoped name with a version is the name form, as before", () => {
  assertEquals(resolvePromoteTarget("@myorg/ext", "2026.06.10.1"), {
    kind: "name",
    name: "@myorg/ext",
    version: "2026.06.10.1",
  });
});

Deno.test("resolvePromoteTarget: a scoped name without a version asks for one", () => {
  assertThrows(
    () => resolvePromoteTarget("@myorg/ext", undefined),
    UserError,
    "Missing version",
  );
});

Deno.test("resolvePromoteTarget: a path or directory is a manifest", () => {
  assertEquals(
    resolvePromoteTarget("extensions/models/my-ext/manifest.yaml", undefined),
    { kind: "manifest", path: "extensions/models/my-ext/manifest.yaml" },
  );
  assertEquals(resolvePromoteTarget(".", undefined), {
    kind: "manifest",
    path: ".",
  });
});

Deno.test("resolvePromoteTarget: a mistyped name with a version keeps the name error", () => {
  const error = assertThrows(
    () => resolvePromoteTarget("myorg/ext", "2026.06.10.1"),
    UserError,
  );
  assertEquals(
    error.message,
    'Invalid extension name: "myorg/ext". Must match @collective/name pattern ' +
      "(lowercase, alphanumeric, hyphens, underscores, additional /segments allowed). " +
      "To promote the version a manifest names, pass only the manifest path.",
  );
});

Deno.test("resolvePromoteTarget: --from-channel is refused with a manifest", () => {
  assertThrows(
    () => resolvePromoteTarget("manifest.yaml", undefined, "rc"),
    UserError,
    "--from-channel cannot be used with a manifest",
  );
});

Deno.test("resolvePromoteTarget: --from-channel still works with a name", () => {
  assertEquals(resolvePromoteTarget("@myorg/ext", "2026.06.10.1", "rc"), {
    kind: "name",
    name: "@myorg/ext",
    version: "2026.06.10.1",
  });
});

Deno.test("withExtensionNameHint: a missing manifest suggests the name form", () => {
  const error = withExtensionNameHint(
    new UserError(
      "Manifest file not found: myorg/ext (looked in /r/myorg/ext)",
    ),
  ) as UserError;
  assertEquals(
    error.message,
    "Manifest file not found: myorg/ext (looked in /r/myorg/ext)\n" +
      "If you meant an extension name, pass @collective/name <version>.",
  );
});

Deno.test("withExtensionNameHint: other errors pass through unchanged", () => {
  const error = new UserError("No manifest.yaml found in /r/ext");
  assertEquals(
    (withExtensionNameHint(error) as UserError).message,
    "No manifest.yaml found in /r/ext",
  );
});
