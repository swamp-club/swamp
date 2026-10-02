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
import {
  flushAuthGateWarning,
  renderAuthGateWarning,
  takeAuthGateWarning,
} from "./auth_gate_warning.ts";

Deno.test("renderAuthGateWarning: JSON mode holds the warning and registers an exit hook", () => {
  const hooks: (() => void)[] = [];
  try {
    renderAuthGateWarning(
      "json",
      "Running offline",
      (hook) => hooks.push(hook),
    );
    assertEquals(hooks.length, 1);
    assertEquals(takeAuthGateWarning(), {
      warning: "Running offline",
      authMode: "offline",
    });
    assertEquals(takeAuthGateWarning(), undefined);
  } finally {
    takeAuthGateWarning();
  }
});

Deno.test("renderAuthGateWarning: the exit hook writes the held warning once", () => {
  const hooks: (() => void)[] = [];
  const originalError = console.error;
  const lines: string[] = [];
  try {
    console.error = (...args: unknown[]) => lines.push(args.join(" "));
    renderAuthGateWarning(
      "json",
      "Running offline",
      (hook) => hooks.push(hook),
    );
    hooks[0]();
    hooks[0]();
    assertEquals(lines.map((line) => JSON.parse(line)), [
      { warning: "Running offline", authMode: "offline" },
    ]);
  } finally {
    console.error = originalError;
    takeAuthGateWarning();
  }
});

Deno.test("flushAuthGateWarning: writes one JSON line, then nothing", () => {
  const lines: string[] = [];
  try {
    renderAuthGateWarning("json", "Running offline", () => {});
    flushAuthGateWarning((line) => lines.push(line));
    flushAuthGateWarning((line) => lines.push(line));
    assertEquals(lines.length, 1);
    assertEquals(JSON.parse(lines[0]), {
      warning: "Running offline",
      authMode: "offline",
    });
  } finally {
    takeAuthGateWarning();
  }
});

Deno.test("flushAuthGateWarning: writes nothing when the exit hook follows a taken warning", () => {
  const lines: string[] = [];
  renderAuthGateWarning("json", "Running offline", () => {});
  takeAuthGateWarning();
  flushAuthGateWarning((line) => lines.push(line));
  assertEquals(lines, []);
});

Deno.test("renderAuthGateWarning: log mode holds nothing and registers no hook", () => {
  const hooks: (() => void)[] = [];
  renderAuthGateWarning("log", "Running offline", (hook) => hooks.push(hook));
  assertEquals(hooks, []);
  assertEquals(takeAuthGateWarning(), undefined);
});
