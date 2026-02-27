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

import { assertStringIncludes } from "@std/assert/string-includes";
import {
  renderExtensionPull,
  renderExtensionPullCancelled,
  renderExtensionPullConflicts,
  renderExtensionPullDependencyPull,
  renderExtensionPullPlatforms,
  renderExtensionPullResolved,
  renderExtensionPullSafetyErrors,
  renderExtensionPullSafetyWarnings,
} from "./extension_pull_output.ts";

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

Deno.test("renderExtensionPullResolved outputs JSON in json mode", () => {
  const output = captureConsoleLog(() => {
    renderExtensionPullResolved(
      {
        name: "@test/ext",
        version: "2026.02.26.1",
        description: "A test extension",
      },
      "json",
    );
  });
  const parsed = JSON.parse(output);
  assertStringIncludes(parsed.name, "@test/ext");
  assertStringIncludes(parsed.version, "2026.02.26.1");
});

Deno.test("renderExtensionPull outputs JSON in json mode", () => {
  const output = captureConsoleLog(() => {
    renderExtensionPull(
      {
        name: "@test/ext",
        version: "2026.02.26.1",
        extractedFiles: ["extensions/models/model.ts"],
      },
      "json",
    );
  });
  const parsed = JSON.parse(output);
  assertStringIncludes(parsed.name, "@test/ext");
  assertStringIncludes(parsed.extractedFiles[0], "model.ts");
});

Deno.test("renderExtensionPullCancelled outputs JSON in json mode", () => {
  const output = captureConsoleLog(() => {
    renderExtensionPullCancelled("json");
  });
  const parsed = JSON.parse(output);
  assertStringIncludes(parsed.status, "cancelled");
});

Deno.test("renderExtensionPullConflicts outputs JSON in json mode", () => {
  const output = captureConsoleLog(() => {
    renderExtensionPullConflicts(
      ["extensions/models/model.ts"],
      "json",
    );
  });
  const parsed = JSON.parse(output);
  assertStringIncludes(parsed.conflicts[0], "model.ts");
});

Deno.test("renderExtensionPullDependencyPull outputs JSON in json mode", () => {
  const output = captureConsoleLog(() => {
    renderExtensionPullDependencyPull("@test/dep", "2026.02.26.1", "json");
  });
  const parsed = JSON.parse(output);
  assertStringIncludes(parsed.name, "@test/dep");
  assertStringIncludes(parsed.status, "pulling_dependency");
});

Deno.test("renderExtensionPullSafetyErrors outputs JSON in json mode", () => {
  const output = captureConsoleLog(() => {
    renderExtensionPullSafetyErrors(
      [{ file: "evil.ts", message: "contains eval()" }],
      "json",
    );
  });
  const parsed = JSON.parse(output);
  assertStringIncludes(parsed.errors[0].file, "evil.ts");
});

Deno.test("renderExtensionPullPlatforms outputs JSON in json mode", () => {
  const output = captureConsoleLog(() => {
    renderExtensionPullPlatforms(
      ["darwin-aarch64", "linux-x86_64"],
      "json",
    );
  });
  const parsed = JSON.parse(output);
  assertStringIncludes(parsed.platforms[0], "darwin-aarch64");
  assertStringIncludes(parsed.platforms[1], "linux-x86_64");
});

Deno.test("renderExtensionPullSafetyWarnings outputs JSON in json mode", () => {
  const output = captureConsoleLog(() => {
    renderExtensionPullSafetyWarnings(
      [{ file: "model.ts", message: "uses Deno.Command()" }],
      "json",
    );
  });
  const parsed = JSON.parse(output);
  assertStringIncludes(parsed.warnings[0].file, "model.ts");
});
