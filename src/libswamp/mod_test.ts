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

// the only importer of the barrel; type-checking and loading this file checks
// that every re-export in mod.ts still resolves

import { assertEquals } from "@std/assert";
import * as libswamp from "./mod.ts";
import { createLibSwampContext } from "./context.ts";
import { consumeStream } from "./stream.ts";

Deno.test("libswamp barrel: re-exports resolve to the defining module's bindings", () => {
  assertEquals(libswamp.createLibSwampContext, createLibSwampContext);
  assertEquals(libswamp.consumeStream, consumeStream);
});
