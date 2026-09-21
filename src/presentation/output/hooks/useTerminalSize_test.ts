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
import { getTerminalDimensions } from "./useTerminalSize.ts";

/** A console-size probe that fails, as it does when no console is attached. */
const noConsole = () => {
  throw new TypeError("The handle is invalid.");
};

Deno.test("getTerminalDimensions: prefers the console size over stdout properties", () => {
  const fakeStdout = {
    columns: 120,
    rows: 40,
  } as unknown as NodeJS.WriteStream;

  const size = getTerminalDimensions(fakeStdout, () => ({
    columns: 200,
    rows: 50,
  }));

  assertEquals(size, { width: 200, height: 50 });
});

Deno.test("getTerminalDimensions: falls back to stdout properties when the console size is unavailable", () => {
  const fakeStdout = {
    columns: 120,
    rows: 40,
  } as unknown as NodeJS.WriteStream;

  const size = getTerminalDimensions(fakeStdout, noConsole);

  assertEquals(size, { width: 120, height: 40 });
});

Deno.test("getTerminalDimensions: falls back to defaults when stdout is undefined", () => {
  const size = getTerminalDimensions(undefined, noConsole);

  assertEquals(size, { width: 80, height: 24 });
});

Deno.test("getTerminalDimensions: falls back to defaults when stdout has no columns/rows", () => {
  const fakeStdout = {} as unknown as NodeJS.WriteStream;

  const size = getTerminalDimensions(fakeStdout, noConsole);

  assertEquals(size, { width: 80, height: 24 });
});

Deno.test("getTerminalDimensions: default probe returns a size in either environment", () => {
  // Exercises the real Deno.consoleSize() default. Both branches are valid
  // here — attached to a console it reports the pane, under a pipe it falls
  // back — so assert only what holds in both: a usable pair of dimensions.
  const size = getTerminalDimensions({
    columns: 120,
    rows: 40,
  } as unknown as NodeJS.WriteStream);

  assertEquals(typeof size.width, "number");
  assertEquals(typeof size.height, "number");
});

Deno.test("getTerminalDimensions: treats a 0x0 console as unavailable", () => {
  // A pty with no attached window reports 0x0 without throwing. Zero is not a
  // usable width — callers divide by it and pass it to String.repeat.
  const fakeStdout = {
    columns: 120,
    rows: 40,
  } as unknown as NodeJS.WriteStream;

  const size = getTerminalDimensions(fakeStdout, () => ({
    columns: 0,
    rows: 0,
  }));

  assertEquals(size, { width: 120, height: 40 });
});

Deno.test("getTerminalDimensions: falls back to defaults when both console and stdout are zero", () => {
  const fakeStdout = {
    columns: 0,
    rows: 0,
  } as unknown as NodeJS.WriteStream;

  const size = getTerminalDimensions(fakeStdout, () => ({
    columns: 0,
    rows: 0,
  }));

  assertEquals(size, { width: 80, height: 24 });
});
