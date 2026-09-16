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

import { assertEquals, assertStringIncludes } from "@std/assert";
import { renderAuthWarning, renderFirstRunWarning } from "./auth_nudge.ts";

Deno.test("renderAuthWarning: outputs warning message with deadline to stderr", () => {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    lines.push(
      args.map((a) => typeof a === "string" ? a : String(a)).join(" "),
    );
  };
  try {
    renderAuthWarning();
  } finally {
    console.error = original;
  }

  assertEquals(lines.length, 2);
  assertEquals(lines[0], "");
  // deno-lint-ignore no-control-regex
  const stripped = lines[1].replace(/\x1b\[[0-9;]*m/g, "");
  assertStringIncludes(stripped, "require authentication");
  assertStringIncludes(stripped, "October 1st, 2026");
  assertStringIncludes(stripped, "swamp auth login");
});

Deno.test("renderFirstRunWarning: outputs boxed warning with deadline to stderr", () => {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    lines.push(
      args.map((a) => typeof a === "string" ? a : String(a)).join(" "),
    );
  };
  try {
    renderFirstRunWarning();
  } finally {
    console.error = original;
  }

  // deno-lint-ignore no-control-regex
  const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
  const stripped = lines.map(strip);

  assertStringIncludes(stripped.join("\n"), "Authentication required");
  assertStringIncludes(stripped.join("\n"), "October 1st, 2026");
  assertStringIncludes(stripped.join("\n"), "swamp auth login");

  const topBorder = stripped.find((l) => l.includes("┌"));
  const bottomBorder = stripped.find((l) => l.includes("└"));
  assertEquals(topBorder !== undefined, true);
  assertEquals(bottomBorder !== undefined, true);
});
