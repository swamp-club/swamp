// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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

import { assertEquals } from "@std/assert/equals";
import { assertStringIncludes } from "@std/assert/string-includes";
import {
  renderExtensionYank,
  renderExtensionYankCancelled,
} from "./extension_yank_output.ts";

function captureConsoleLog(fn: () => void): string {
  const original = console.log;
  let captured = "";
  console.log = (msg: string) => {
    captured += msg;
  };
  try {
    fn();
  } finally {
    console.log = original;
  }
  return captured;
}

Deno.test("renderExtensionYank outputs JSON with version in json mode", () => {
  const output = captureConsoleLog(() => {
    renderExtensionYank(
      {
        name: "@test/ext",
        version: "2026.02.26.1",
        reason: "Security vulnerability",
      },
      "json",
    );
  });
  const parsed = JSON.parse(output);
  assertStringIncludes(parsed.yanked.name, "@test/ext");
  assertEquals(parsed.yanked.version, "2026.02.26.1");
  assertStringIncludes(parsed.yanked.reason, "Security vulnerability");
});

Deno.test("renderExtensionYank outputs JSON without version in json mode", () => {
  const output = captureConsoleLog(() => {
    renderExtensionYank(
      {
        name: "@test/ext",
        version: null,
        reason: "Policy violation",
      },
      "json",
    );
  });
  const parsed = JSON.parse(output);
  assertStringIncludes(parsed.yanked.name, "@test/ext");
  assertEquals(parsed.yanked.version, null);
});

Deno.test("renderExtensionYankCancelled outputs JSON in json mode", () => {
  const output = captureConsoleLog(() => {
    renderExtensionYankCancelled("json");
  });
  const parsed = JSON.parse(output);
  assertStringIncludes(parsed.status, "cancelled");
});
