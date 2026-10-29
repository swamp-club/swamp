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
import { placeShellData, type ShellDialect } from "./shell_data_placement.ts";

/** Authored shell text around a splice: quotes, operators and plain words. */
const authoredText = fc.stringMatching(/^[a-z "'$;|&<>()\n=-]{0,24}$/);

/** Data text of any character a caller could send. */
const dataText = fc.string({ minLength: 1, maxLength: 24, unit: "binary" });

const dialect = fc.constantFrom<ShellDialect>("posix", "powershell");

Deno.test("placeShellData: the placed command never depends on the data text", () => {
  // The shell parses only the placed command, so if the command is the same
  // whatever the data holds, no data can ever become syntax. The data only
  // reaches the shell through the environment, unchanged.
  fc.assert(
    fc.property(
      authoredText,
      authoredText,
      dataText,
      dataText,
      dialect,
      (before, after, data, other, shell) => {
        const range = [[before.length, before.length + data.length] as const];
        const otherRange = [
          [before.length, before.length + other.length] as const,
        ];
        const placed = placeShellData(
          before + data + after,
          range,
          [],
          shell,
        );
        const placedOther = placeShellData(
          before + other + after,
          otherRange,
          [],
          shell,
        );
        assertEquals(placed.refused, placedOther.refused);
        if (placed.refused) {
          assertEquals(placed.env, {});
          return;
        }
        assertEquals(placed.command, placedOther.command);
        assertEquals(Object.values(placed.env), [data]);
      },
    ),
  );
});

Deno.test("placeShellData: authored text outside the ranges is kept byte for byte", () => {
  fc.assert(
    fc.property(
      authoredText,
      authoredText,
      dataText,
      dialect,
      (before, after, data, shell) => {
        const placed = placeShellData(
          before + data + after,
          [[before.length, before.length + data.length]],
          [],
          shell,
        );
        if (placed.refused) return;
        assert(placed.command.startsWith(before));
        assert(placed.command.endsWith(after));
      },
    ),
  );
});
