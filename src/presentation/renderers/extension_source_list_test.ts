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

import { assertEquals, assertStringIncludes } from "@std/assert";
import { createSourceListRenderer } from "./extension_source_list.ts";

/**
 * Captures `console.log` output across a callback. Strips ANSI colour
 * codes so assertions stay stable regardless of terminal. `writeOutput`
 * from the logger module wraps `console.log` directly — swapping the
 * global is the lightest-weight spy for these renderer tests.
 */
async function captureLog(fn: () => Promise<void> | void): Promise<string[]> {
  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    await fn();
  } finally {
    console.log = originalLog;
  }
  // Strip ANSI sequences.
  // deno-lint-ignore no-control-regex
  const ansi = /\x1b\[[0-9;]*m/g;
  return lines.map((l) => l.replace(ansi, ""));
}

Deno.test("extension_source_list renderer: shows kinds line for valid source", async () => {
  const renderer = createSourceListRenderer("log");
  const handlers = renderer.handlers();
  const lines = await captureLog(() => {
    handlers.completed({
      kind: "completed",
      data: {
        sources: [
          {
            path: "/a",
            expandedPaths: ["/a"],
            status: "valid",
            resolvedKinds: ["models", "workflows"],
          },
        ],
      },
    });
  });
  const joined = lines.join("\n");
  assertStringIncludes(joined, "/a");
  assertStringIncludes(joined, "kinds: models, workflows");
});

Deno.test("extension_source_list renderer: omits kinds line when resolvedKinds is empty/absent", async () => {
  const renderer = createSourceListRenderer("log");
  const handlers = renderer.handlers();
  const lines = await captureLog(() => {
    handlers.completed({
      kind: "completed",
      data: {
        sources: [
          {
            path: "/b",
            expandedPaths: ["/b"],
            status: "valid",
          },
        ],
      },
    });
  });
  const joined = lines.join("\n");
  assertStringIncludes(joined, "/b");
  assertEquals(joined.includes("kinds:"), false);
});

Deno.test("extension_source_list renderer: no_extensions status shows message + remediation hint", async () => {
  const renderer = createSourceListRenderer("log");
  const handlers = renderer.handlers();
  const lines = await captureLog(() => {
    handlers.completed({
      kind: "completed",
      data: {
        sources: [
          {
            path: "/c",
            expandedPaths: ["/c"],
            status: "no_extensions",
          },
        ],
      },
    });
  });
  const joined = lines.join("\n");
  assertStringIncludes(joined, "no extensions found");
  // Remediation hint so users know how to recover without consulting docs.
  assertStringIncludes(joined, "swamp extension source rm /c");
});

Deno.test("extension_source_list renderer: path_not_found status shows message + remediation hint", async () => {
  const renderer = createSourceListRenderer("log");
  const handlers = renderer.handlers();
  const lines = await captureLog(() => {
    handlers.completed({
      kind: "completed",
      data: {
        sources: [
          {
            path: "/d",
            expandedPaths: ["/d"],
            status: "path_not_found",
          },
        ],
      },
    });
  });
  const joined = lines.join("\n");
  assertStringIncludes(joined, "path not found");
  assertStringIncludes(joined, "swamp extension source rm /d");
});

Deno.test("extension_source_list renderer: JSON mode passes resolvedKinds through", async () => {
  const renderer = createSourceListRenderer("json");
  const handlers = renderer.handlers();
  const lines = await captureLog(() => {
    handlers.completed({
      kind: "completed",
      data: {
        sources: [
          {
            path: "/e",
            expandedPaths: ["/e"],
            status: "valid",
            resolvedKinds: ["models"],
          },
        ],
      },
    });
  });
  const joined = lines.join("\n");
  const parsed = JSON.parse(joined);
  assertEquals(parsed.sources[0].resolvedKinds, ["models"]);
});
