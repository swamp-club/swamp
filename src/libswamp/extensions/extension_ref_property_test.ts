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
import { extensionDependencyName } from "../../domain/extensions/extension_manifest.ts";
import { parseExtensionRef } from "./pull.ts";

Deno.test("parseExtensionRef: names the same extension as extensionDependencyName", () => {
  fc.assert(
    fc.property(
      fc.array(fc.constantFrom("@", "/", "a", "1", ".", "-"), {
        maxLength: 24,
      }).map((chars) => `@${chars.join("")}`),
      (spec) => {
        let parsed: string;
        try {
          parsed = parseExtensionRef(spec).name;
        } catch {
          return;
        }
        assertEquals(extensionDependencyName(spec), parsed);
      },
    ),
  );
});
