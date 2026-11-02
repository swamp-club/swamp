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

import { assert } from "@std/assert";
import { join } from "@std/path";
import { dataNamePortability } from "../src/domain/data/data.ts";

// the writer refuses a name on Windows only when Windows could not store it
// anyway: every character it refuses also makes Deno.mkdir fail; / and \ are
// already rejected by DataMetadataSchema
Deno.test({
  name:
    "dataNamePortability: every name refused on windows also fails Deno.mkdir there",
  ignore: Deno.build.os !== "windows",
  fn: async () => {
    const dir = await Deno.makeTempDir({ prefix: "swamp-portability-test-" });
    try {
      let refused = 0;
      for (let code = 1; code < 128; code++) {
        const c = String.fromCharCode(code);
        if (c === "/" || c === "\\") continue;
        const name = `a${c}b`;
        if (dataNamePortability(name, "windows").kind !== "refuse") continue;
        refused++;
        let failed = false;
        try {
          await Deno.mkdir(join(dir, name));
        } catch {
          failed = true;
        }
        assert(failed, `Deno.mkdir accepted ${JSON.stringify(name)}`);
      }
      assert(refused === 38, `expected 38 refused names, got ${refused}`);
    } finally {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  },
});
