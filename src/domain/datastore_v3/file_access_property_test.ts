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

import { assert, assertEquals } from "@std/assert";
import fc from "fast-check";
import {
  fileAccessOf,
  modeWithAccess,
  satisfiesAccess,
} from "./file_access.ts";

const arbMode = fc.integer({ min: 0, max: 0o777 });
const arbAccess = fc.constantFrom(
  undefined,
  "executable" as const,
  "private" as const,
  "private-executable" as const,
);

Deno.test("modeWithAccess: never widens and keeps the owner's read and write", () => {
  fc.assert(
    fc.property(arbMode, arbAccess, (created, access) => {
      const mode = modeWithAccess(created, access);
      // Read and write bits are only ever kept or cleared, never added.
      assertEquals(mode & 0o666 & ~created, 0);
      assertEquals(mode & 0o600, created & 0o600);
      if (access === "private" || access === "private-executable") {
        assertEquals(mode & 0o077, 0);
      }
      if (access === undefined) assertEquals(mode, created);
    }),
  );
});

Deno.test("modeWithAccess: a writer's access survives a checkout's umask", () => {
  // The writer's file has `written`; another checkout creates its file with
  // 0666 masked by `umask` and applies the access the writer recorded.
  fc.assert(
    fc.property(
      arbMode,
      fc.integer({ min: 0, max: 0o077 }),
      (written, umask) => {
        const access = fileAccessOf(written);
        const mode = modeWithAccess(0o666 & ~umask, access);
        if (access === "private" || access === "private-executable") {
          assertEquals(mode & 0o077, 0);
        }
        // Owner read is never masked here, so executable always yields u+x.
        if (access === "executable" || access === "private-executable") {
          assert((mode & 0o100) !== 0);
        }
        if (access === undefined) assertEquals(mode, 0o666 & ~umask);
      },
    ),
  );
});

Deno.test("satisfiesAccess: a file written with an access has it under any umask, so it is never rewritten again", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 0, max: 0o077 }),
      arbAccess,
      (umask, access) => {
        // A new file's mode under `umask`, as the read model's temp file has.
        const created = 0o666 & ~umask;
        assert(satisfiesAccess(modeWithAccess(created, access), access));
      },
    ),
  );
});

Deno.test("satisfiesAccess: the writer's own file satisfies the access it records", () => {
  fc.assert(
    fc.property(arbMode, (mode) => {
      assert(satisfiesAccess(mode, fileAccessOf(mode)));
    }),
  );
});
