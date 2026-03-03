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
  renderExtensionPush,
  renderExtensionPushCancelled,
  renderExtensionPushCompilationErrors,
  renderExtensionPushDryRun,
  renderExtensionPushResolved,
  renderExtensionPushSafetyErrors,
  renderExtensionPushSafetyWarnings,
} from "./extension_push_output.ts";

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

Deno.test("renderExtensionPushResolved outputs JSON in json mode", () => {
  const output = captureConsoleLog(() => {
    renderExtensionPushResolved(
      {
        name: "@test/ext",
        version: "2026.02.26.1",
        description: "Test extension",
        repository: undefined,
        modelFiles: ["model.ts"],
        workflowFiles: [],
        vaultFiles: [],
        additionalFiles: [],
        platforms: [],
        labels: [],
        dependencies: [],
      },
      "json",
    );
  });
  const parsed = JSON.parse(output);
  assertStringIncludes(parsed.name, "@test/ext");
});

Deno.test("renderExtensionPush outputs JSON in json mode", () => {
  const output = captureConsoleLog(() => {
    renderExtensionPush(
      {
        name: "@test/ext",
        version: "2026.02.26.1",
        extensionId: "ext-123",
        archiveSize: 2048,
        modelCount: 1,
        workflowCount: 0,
        bundleCount: 1,
        vaultCount: 0,
      },
      "json",
    );
  });
  const parsed = JSON.parse(output);
  assertStringIncludes(parsed.extensionId, "ext-123");
});

Deno.test("renderExtensionPushCancelled outputs JSON in json mode", () => {
  const output = captureConsoleLog(() => {
    renderExtensionPushCancelled("json");
  });
  const parsed = JSON.parse(output);
  assertStringIncludes(parsed.status, "cancelled");
});

Deno.test("renderExtensionPushCompilationErrors outputs JSON in json mode", () => {
  const output = captureConsoleLog(() => {
    renderExtensionPushCompilationErrors(
      [{ file: "model.ts", error: "syntax error" }],
      "json",
    );
  });
  const parsed = JSON.parse(output);
  assertStringIncludes(parsed.compilationErrors[0].file, "model.ts");
});

Deno.test("renderExtensionPushSafetyWarnings outputs JSON in json mode", () => {
  const output = captureConsoleLog(() => {
    renderExtensionPushSafetyWarnings(
      [{ file: "model.ts", message: "uses Deno.Command()" }],
      "json",
    );
  });
  const parsed = JSON.parse(output);
  assertStringIncludes(parsed.warnings[0].file, "model.ts");
});

Deno.test("renderExtensionPushSafetyErrors outputs JSON in json mode", () => {
  const output = captureConsoleLog(() => {
    renderExtensionPushSafetyErrors(
      [{ file: "evil.ts", message: "contains eval()" }],
      "json",
    );
  });
  const parsed = JSON.parse(output);
  assertStringIncludes(parsed.errors[0].file, "evil.ts");
});

Deno.test("renderExtensionPushDryRun outputs JSON in json mode", () => {
  const output = captureConsoleLog(() => {
    renderExtensionPushDryRun(
      { name: "@test/ext", version: "2026.02.26.1", archiveSize: 1024 },
      "json",
    );
  });
  const parsed = JSON.parse(output);
  assertStringIncludes(parsed.status, "dry_run");
});
