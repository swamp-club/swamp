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
import { extensionDependencyName } from "./extension_manifest.ts";

const arbSegment = fc.stringMatching(/^[a-z0-9][a-z0-9-]{0,15}$/);

const arbExtensionName = fc
  .tuple(arbSegment, fc.array(arbSegment, { minLength: 1, maxLength: 3 }))
  .map(([collective, rest]) => `@${collective}/${rest.join("/")}`);

const arbVersion = fc.stringMatching(/^[0-9A-Za-z.+-]{1,24}$/);

Deno.test("extensionDependencyName: a pinned or bare entry yields the extension name", () => {
  fc.assert(
    fc.property(arbExtensionName, arbVersion, (name, version) => {
      assertEquals(extensionDependencyName(`${name}@${version}`), name);
      assertEquals(extensionDependencyName(name), name);
    }),
  );
});
