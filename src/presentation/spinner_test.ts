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
import { Spinner } from "./spinner.ts";

/** Removes color codes only, keeping the row-clearing sequence. */
function withoutColor(text: string): string {
  // deno-lint-ignore no-control-regex
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

function recordingSpinner(isTerminal = true) {
  const written: string[] = [];
  const spinner = new Spinner({
    write: (text) => written.push(withoutColor(text)),
    isTerminal: () => isTerminal,
  });
  return { spinner, written };
}

Deno.test("Spinner: start draws the frame and message on the current row", () => {
  const { spinner, written } = recordingSpinner();
  spinner.start("Updating swamp...");
  spinner.stop();

  assertEquals(written[0], "\r\x1b[K⠋ Updating swamp...");
});

Deno.test("Spinner: stop clears the row and writes no newline", () => {
  const { spinner, written } = recordingSpinner();
  spinner.start("Updating swamp...");
  spinner.stop();

  assertEquals(written.at(-1), "\r\x1b[K");
});

Deno.test("Spinner: finish leaves the line in place followed by a newline", () => {
  const { spinner, written } = recordingSpinner();
  spinner.start("Updating swamp...");
  spinner.finish("done");

  assertEquals(written.at(-1), "\r\x1b[Kdone\n");
});

Deno.test("Spinner: stop after finish writes nothing more", () => {
  const { spinner, written } = recordingSpinner();
  spinner.start("Updating swamp...");
  spinner.finish("done");
  const count = written.length;
  spinner.stop();

  assertEquals(written.length, count);
});

Deno.test("Spinner: off a terminal nothing is written, even by finish", () => {
  const { spinner, written } = recordingSpinner(false);
  spinner.start("Updating swamp...");
  spinner.update("Downloading");
  spinner.finish("done");
  spinner.stop();

  assertEquals(written, []);
});
