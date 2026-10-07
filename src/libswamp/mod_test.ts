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

// The only importer of the barrel. Production code and every other test
// import each name from the file that defines it, so nothing else would
// notice a re-export in mod.ts that no longer resolves. Type-checking this
// file checks every `export … from` in the barrel; loading it links them.
// `integration/ddd_layer_rules_test.ts` pins this file as the one exception
// to "nothing imports mod.ts".

import { assertEquals } from "@std/assert";
import * as libswamp from "./mod.ts";
import { createLibSwampContext } from "./context.ts";
import { consumeStream } from "./stream.ts";

Deno.test("libswamp barrel: re-exports resolve to the defining module's bindings", () => {
  assertEquals(libswamp.createLibSwampContext, createLibSwampContext);
  assertEquals(libswamp.consumeStream, consumeStream);
});
