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
import { stripAnsiCode } from "@std/fmt/colors";
import type { ExtensionFmtEvent } from "../../libswamp/extensions/fmt.ts";
import { initializeLogging } from "../../infrastructure/logging/logger.ts";
import { createExtensionFmtRenderer } from "./extension_fmt.ts";

await initializeLogging({});

/**
 * Captures what LogTape's console sink and the JSON renderer write:
 * console.log, console.info, console.warn and console.error.
 */
function capture(run: () => void | Promise<void>): Promise<string[]> {
  const logs: string[] = [];
  const original = {
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error,
  };
  const push = (...args: unknown[]) => {
    logs.push(
      stripAnsiCode(
        args.map((a) => typeof a === "string" ? a : String(a)).join(" "),
      ),
    );
  };
  console.log = push;
  console.info = push;
  console.warn = push;
  console.error = push;
  return Promise.resolve()
    .then(run)
    .then(() => logs)
    .finally(() => {
      console.log = original.log;
      console.info = original.info;
      console.warn = original.warn;
      console.error = original.error;
    });
}

const FMT_DIFF = [
  "from /repo/extensions/models/a.ts:",
  '1 | -import { z } from "npm:zod@4";',
  "1 | +import { z } from 'npm:zod@4';",
  "2 | +export const model = {",
  "3 | +};",
  "",
  "error: Found 1 not formatted file in 1 file",
  "",
].join("\n");

const checkFailed: ExtensionFmtEvent = {
  kind: "completed",
  data: {
    mode: "check",
    passed: false,
    issues: [{ check: "fmt", output: FMT_DIFF }],
  },
};

/** No LogTape string-concatenation lines, and no line that is a quoted value. */
function assertPlain(logs: string[]): void {
  for (const line of logs) {
    assertEquals(line.trimEnd().endsWith('" +'), false, line);
    assertEquals(line.trimEnd().endsWith("' +"), false, line);
    assertEquals(/extension·fmt: ["']/.test(line), false, line);
    assertEquals(line.includes("\\n"), false, line);
  }
}

Deno.test("extensionFmtRenderer: log prints a failed check's output one plain line per line (swamp-club#3149)", async () => {
  const renderer = createExtensionFmtRenderer("log");
  const logs = await capture(() => renderer.handlers().completed(checkFailed));
  assertPlain(logs);
  const output = logs.join("\n");
  assertStringIncludes(output, "Quality checks failed:");
  assertStringIncludes(output, "    from /repo/extensions/models/a.ts:\n");
  assertStringIncludes(output, '    1 | -import { z } from "npm:zod@4";\n');
  assertStringIncludes(output, "    1 | +import { z } from 'npm:zod@4';\n");
  assertStringIncludes(output, "    2 | +export const model = {\n");
  assertStringIncludes(output, "    3 | +};\n");
  assertStringIncludes(
    output,
    "    error: Found 1 not formatted file in 1 file",
  );
  assertEquals(renderer.passed(), false);
  assertStringIncludes(renderer.failureMessage(), "Quality checks failed.");
});

Deno.test("extensionFmtRenderer: log prints fix-mode fmt and lint output as plain lines", async () => {
  const renderer = createExtensionFmtRenderer("log");
  const logs = await capture(() =>
    renderer.handlers().completed({
      kind: "completed",
      data: {
        mode: "fix",
        fileCount: 1,
        fmtOutput: "/repo/extensions/models/a.ts\nChecked 1 file",
        lintOutput: "Checked 1 file",
        remainingIssues: [],
        passed: true,
      },
    })
  );
  assertPlain(logs);
  assertEquals(logs.length, 4);
  assertEquals(logs[0].endsWith("Formatted 1 TypeScript files."), true);
  assertEquals(logs[1].endsWith(": /repo/extensions/models/a.ts"), true);
  assertEquals(logs[2].endsWith(": Checked 1 file"), true);
  assertEquals(logs[3].endsWith(": Checked 1 file"), true);
  assertEquals(renderer.passed(), true);
});

Deno.test("extensionFmtRenderer: log prints fix-mode remaining issues as plain lines and omits empty output", async () => {
  const renderer = createExtensionFmtRenderer("log");
  const logs = await capture(() =>
    renderer.handlers().completed({
      kind: "completed",
      data: {
        mode: "fix",
        fileCount: 2,
        fmtOutput: "",
        lintOutput: "",
        remainingIssues: [{
          check: "lint",
          output:
            "error[require-await]: no await\n  --> a.ts:1:1\nFound 1 problem\n",
        }],
        passed: false,
      },
    })
  );
  assertPlain(logs);
  assertEquals(logs.length, 6);
  const output = logs.join("\n");
  assertStringIncludes(output, "Remaining issues that could not be auto-fixed");
  assertStringIncludes(output, "    error[require-await]: no await\n");
  assertStringIncludes(output, "      --> a.ts:1:1\n");
  assertStringIncludes(output, "    Found 1 problem");
  assertEquals(renderer.passed(), false);
  assertStringIncludes(renderer.failureMessage(), "could not be auto-fixed");
});

Deno.test("extensionFmtRenderer: json carries a failed check's output unchanged", async () => {
  const renderer = createExtensionFmtRenderer("json");
  const logs = await capture(() => renderer.handlers().completed(checkFailed));
  assertEquals(JSON.parse(logs.join("\n")), {
    status: "failed",
    issues: [{ check: "fmt", output: FMT_DIFF }],
  });
  assertEquals(renderer.passed(), false);
});
