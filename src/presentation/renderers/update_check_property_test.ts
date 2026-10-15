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

// The live progress line is redrawn by clearing only its own row, so a line
// wider than the terminal wraps and leaves copies behind. These properties
// pin that every line fits, measured on what is visible, and that cutting a
// line never splits a color escape sequence.

import { assert } from "@std/assert";
import fc from "fast-check";
import {
  createUpdateCheckRenderer,
  type UpdateCheckRendererOptions,
} from "./update_check.ts";

/** A complete color (SGR) sequence. */
// deno-lint-ignore no-control-regex
const SGR = /\x1b\[[0-9;]*m/g;

function visibleWidth(line: string): number {
  return line.replace(SGR, "").length;
}

/** True when no escape character is left once whole sequences are removed. */
function escapesAreWhole(line: string): boolean {
  return !line.replace(SGR, "").includes("\x1b");
}

const download = fc.record({
  columns: fc.integer({ min: 1, max: 300 }),
  totalBytes: fc.option(fc.integer({ min: 1, max: 20 * 1024 ** 3 }), {
    nil: null,
  }),
  receivedPermille: fc.integer({ min: 0, max: 1000 }),
  elapsedMs: fc.integer({ min: 0, max: 10 * 3600 * 1000 }),
});

function renderer(
  columns: number,
  lines: string[],
  clock: { at: number },
): ReturnType<typeof createUpdateCheckRenderer> {
  const options: UpdateCheckRendererOptions = {
    spinner: {
      update: (message) => lines.push(message),
      stop: () => {},
      finish: (line) => lines.push(line),
    },
    stderrIsTerminal: true,
    now: () => clock.at,
    columns: () => columns,
  };
  return createUpdateCheckRenderer("log", options);
}

Deno.test("createUpdateCheckRenderer: every live and final line fits the terminal with whole color codes", () => {
  fc.assert(
    fc.property(
      download,
      ({ columns, totalBytes, receivedPermille, elapsedMs }) => {
        const lines: string[] = [];
        const clock = { at: 0 };
        const handlers = renderer(columns, lines, clock).handlers();
        const size = totalBytes ?? 50 * 1024 * 1024;
        handlers.download_progress({
          kind: "download_progress",
          data: { receivedBytes: 0, totalBytes },
        });
        clock.at = elapsedMs;
        handlers.download_progress({
          kind: "download_progress",
          data: {
            receivedBytes: Math.floor((size * receivedPermille) / 1000),
            totalBytes,
          },
        });
        // The success text goes to stdout; only the spinner's lines matter.
        const log = console.log;
        console.log = () => {};
        try {
          handlers.completed({
            kind: "completed",
            data: {
              status: "updated",
              previousVersion: "20261001.120000.0-sha.abcdef1",
              newVersion: "20261015.170000.0-sha.1234567",
            },
          });
        } finally {
          console.log = log;
        }

        for (const line of lines) {
          assert(visibleWidth(line) <= Math.max(0, columns - 2), line);
          assert(escapesAreWhole(line), JSON.stringify(line));
        }
      },
    ),
  );
});
