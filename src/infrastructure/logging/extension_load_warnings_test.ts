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
import {
  emitExtensionLoadWarning,
  emitTypeExtractionFailure,
  resetExtensionLoadWarnings,
} from "./extension_load_warnings.ts";

// Every test in this file MUST call resetExtensionLoadWarnings() at the
// start so the always-on capture array does not bleed warnings between
// cases. The dedupe set already cleared per-case before the array was
// added; the array makes the requirement load-bearing.

function makeCapture() {
  const lines: string[] = [];
  const writer = (line: string) => lines.push(line);
  return { lines, writer };
}

Deno.test("emitExtensionLoadWarning: writes a swamp-warning line and a hint for the kind", () => {
  resetExtensionLoadWarnings();
  const cap = makeCapture();

  emitExtensionLoadWarning(
    { kind: "model", file: "/repo/extensions/models/bad.ts", error: "boom" },
    { writer: cap.writer },
  );

  assertEquals(cap.lines.length, 2);
  assertEquals(
    cap.lines[0],
    "swamp-warning: /repo/extensions/models/bad.ts: boom",
  );
  assertStringIncludes(cap.lines[1], "hint:");
  assertStringIncludes(cap.lines[1], "extensions/models/");
  assertStringIncludes(cap.lines[1], "auto-discovered");
});

Deno.test("emitExtensionLoadWarning: hint is emitted at most once per kind", () => {
  resetExtensionLoadWarnings();
  const cap = makeCapture();

  emitExtensionLoadWarning(
    { kind: "model", file: "/a.ts", error: "e1" },
    { writer: cap.writer },
  );
  emitExtensionLoadWarning(
    { kind: "model", file: "/b.ts", error: "e2" },
    { writer: cap.writer },
  );

  // Two warnings + one hint = three lines total, not four.
  assertEquals(cap.lines.length, 3);
  assertEquals(
    cap.lines.filter((l) => l.includes("hint:")).length,
    1,
  );
});

Deno.test("emitExtensionLoadWarning: hint is kind-specific", () => {
  resetExtensionLoadWarnings();
  const cap = makeCapture();

  emitExtensionLoadWarning(
    { kind: "vault", file: "/v.ts", error: "boom" },
    { writer: cap.writer },
  );

  assertStringIncludes(cap.lines[1], "extensions/vaults/");
});

Deno.test("emitExtensionLoadWarning: each kind gets its own hint once", () => {
  resetExtensionLoadWarnings();
  const cap = makeCapture();

  emitExtensionLoadWarning(
    { kind: "model", file: "/m.ts", error: "e" },
    { writer: cap.writer },
  );
  emitExtensionLoadWarning(
    { kind: "vault", file: "/v.ts", error: "e" },
    { writer: cap.writer },
  );

  const hints = cap.lines.filter((l) => l.includes("hint:"));
  assertEquals(hints.length, 2);
  assertStringIncludes(hints[0], "extensions/models/");
  assertStringIncludes(hints[1], "extensions/vaults/");
});

Deno.test("emitExtensionLoadWarning: de-duplicates on (kind, file, error)", () => {
  resetExtensionLoadWarnings();
  const cap = makeCapture();

  const w = { kind: "model" as const, file: "/m.ts", error: "boom" };
  emitExtensionLoadWarning(w, { writer: cap.writer });
  emitExtensionLoadWarning(w, { writer: cap.writer });
  emitExtensionLoadWarning(w, { writer: cap.writer });

  // One warning + one hint = two lines, not six.
  assertEquals(cap.lines.length, 2);
});

Deno.test("emitExtensionLoadWarning: distinct errors for the same file are NOT deduped", () => {
  resetExtensionLoadWarnings();
  const cap = makeCapture();

  emitExtensionLoadWarning(
    { kind: "model", file: "/m.ts", error: "e1" },
    { writer: cap.writer },
  );
  emitExtensionLoadWarning(
    { kind: "model", file: "/m.ts", error: "e2" },
    { writer: cap.writer },
  );

  // Two distinct warnings + one hint = three lines.
  assertEquals(cap.lines.length, 3);
});

Deno.test("emitExtensionLoadWarning: quiet=true suppresses output entirely", () => {
  resetExtensionLoadWarnings();
  const cap = makeCapture();

  emitExtensionLoadWarning(
    { kind: "model", file: "/m.ts", error: "boom" },
    { writer: cap.writer, quiet: true },
  );

  assertEquals(cap.lines.length, 0);
});

Deno.test("emitExtensionLoadWarning: quiet=false overrides any process-level --quiet detection", () => {
  resetExtensionLoadWarnings();
  const cap = makeCapture();

  // Explicit `false` is the test-seam contract: even if the test runner
  // somehow received `--quiet`, callers asking for output get output.
  emitExtensionLoadWarning(
    { kind: "model", file: "/m.ts", error: "boom" },
    { writer: cap.writer, quiet: false },
  );

  assertEquals(cap.lines.length, 2);
});

Deno.test("emitTypeExtractionFailure: surfaces the regex-mismatch case with a clear message", () => {
  resetExtensionLoadWarnings();
  const cap = makeCapture();

  emitTypeExtractionFailure("/repo/extensions/vaults/odd.ts", "vault", {
    writer: cap.writer,
  });

  assertStringIncludes(cap.lines[0], "/repo/extensions/vaults/odd.ts");
  assertStringIncludes(cap.lines[0], "string literal");
});

Deno.test("resetExtensionLoadWarnings: clears dedupe and hint state", () => {
  resetExtensionLoadWarnings();
  const cap = makeCapture();

  const w = { kind: "model" as const, file: "/m.ts", error: "boom" };
  emitExtensionLoadWarning(w, { writer: cap.writer });
  // Re-emit after reset: should produce a fresh warning + hint.
  resetExtensionLoadWarnings();
  emitExtensionLoadWarning(w, { writer: cap.writer });

  // Two warning lines + two hint lines.
  assertEquals(cap.lines.length, 4);
});
