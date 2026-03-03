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
  renderExtensionRm,
  renderExtensionRmCancelled,
  renderExtensionRmDependencyWarning,
  renderExtensionRmFileDelete,
} from "./extension_rm_output.ts";

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

Deno.test("renderExtensionRm outputs JSON in json mode", () => {
  const output = captureConsoleLog(() => {
    renderExtensionRm(
      {
        name: "@test/ext",
        version: "2026.02.26.1",
        filesDeleted: 3,
        filesSkipped: 0,
        dirsRemoved: 1,
      },
      "json",
    );
  });
  const parsed = JSON.parse(output);
  assertStringIncludes(parsed.removed.name, "@test/ext");
  assertStringIncludes(parsed.removed.version, "2026.02.26.1");
  assertEquals(parsed.removed.filesDeleted, 3);
  assertEquals(parsed.removed.filesSkipped, 0);
  assertEquals(parsed.removed.dirsRemoved, 1);
});

Deno.test("renderExtensionRmCancelled outputs JSON in json mode", () => {
  const output = captureConsoleLog(() => {
    renderExtensionRmCancelled("json");
  });
  const parsed = JSON.parse(output);
  assertStringIncludes(parsed.status, "cancelled");
});

Deno.test("renderExtensionRmDependencyWarning outputs JSON in json mode", () => {
  const output = captureConsoleLog(() => {
    renderExtensionRmDependencyWarning(
      ["@test/other", "@test/another"],
      "json",
    );
  });
  const parsed = JSON.parse(output);
  assertEquals(parsed.dependencyWarning.length, 2);
  assertStringIncludes(parsed.dependencyWarning[0], "@test/other");
  assertStringIncludes(parsed.dependencyWarning[1], "@test/another");
});

Deno.test("renderExtensionRmFileDelete outputs JSON for deleted file", () => {
  const output = captureConsoleLog(() => {
    renderExtensionRmFileDelete(
      "extensions/models/foo/bar.yaml",
      "deleted",
      "json",
    );
  });
  const parsed = JSON.parse(output);
  assertStringIncludes(parsed.file, "foo/bar.yaml");
  assertEquals(parsed.status, "deleted");
});

Deno.test("renderExtensionRmFileDelete outputs JSON for missing file", () => {
  const output = captureConsoleLog(() => {
    renderExtensionRmFileDelete(
      "extensions/models/gone.ts",
      "missing",
      "json",
    );
  });
  const parsed = JSON.parse(output);
  assertStringIncludes(parsed.file, "gone.ts");
  assertEquals(parsed.status, "missing");
});
