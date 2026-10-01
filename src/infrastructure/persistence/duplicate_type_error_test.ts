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

import { assert, assertStringIncludes } from "@std/assert";
import { DuplicateTypeError } from "./duplicate_type_error.ts";

Deno.test("DuplicateTypeError: names attributed occupants by name@version", () => {
  const err = new DuplicateTypeError({
    kind: "model",
    typeNormalized: "@scope/foo",
    firstSource: {
      extensionName: "@a/one",
      extensionVersion: "1.0.0",
      canonicalPath: "/repo/a.ts",
    },
    secondSource: {
      extensionName: "@b/two",
      extensionVersion: "2.0.0",
      canonicalPath: "/repo/b.ts",
    },
  });
  assertStringIncludes(
    err.message,
    "claimed by both @a/one@1.0.0 at /repo/a.ts and @b/two@2.0.0 at /repo/b.ts",
  );
});

Deno.test("DuplicateTypeError: describes occupants with no identity instead of a bare @ (swamp-club#2876)", () => {
  const unattributed = (path: string) => ({
    extensionName: "",
    extensionVersion: "",
    canonicalPath: path,
  });
  const err = new DuplicateTypeError({
    kind: "model",
    typeNormalized: "@acme/thing",
    firstSource: unattributed("/repo/extensions/tf/introspect_test.ts"),
    secondSource: unattributed("/repo/extensions/tf/factory_test.ts"),
  });
  assertStringIncludes(
    err.message,
    "claimed by both a source outside any installed extension at " +
      "/repo/extensions/tf/introspect_test.ts and a source outside any " +
      "installed extension at /repo/extensions/tf/factory_test.ts",
  );
  assert(!err.message.includes(" @ at "));
});
