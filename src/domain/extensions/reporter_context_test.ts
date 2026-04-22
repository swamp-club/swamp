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
import {
  formatReporterContextMarkdown,
  type ReporterContext,
} from "./reporter_context.ts";

const SAMPLE: ReporterContext = {
  extensionName: "@adam/cfgmgmt",
  extensionVersion: "2026.04.22.1",
  swampVersion: "20260422.123456.0-sha.abc123",
  os: "darwin",
  arch: "aarch64",
  shell: "/bin/zsh",
  denoVersion: "1.45.0",
};

Deno.test("formatReporterContextMarkdown: renders a stable shape", () => {
  const expected = [
    "## Environment",
    "- Extension: `@adam/cfgmgmt@2026.04.22.1`",
    "- swamp: `20260422.123456.0-sha.abc123`",
    "- OS: `darwin` (aarch64)",
    "- Deno: `1.45.0`",
    "- Shell: `/bin/zsh`",
  ].join("\n");
  assertEquals(formatReporterContextMarkdown(SAMPLE), expected);
});

Deno.test("formatReporterContextMarkdown: starts with the Environment header", () => {
  const out = formatReporterContextMarkdown(SAMPLE);
  assertStringIncludes(out, "## Environment");
});

Deno.test("formatReporterContextMarkdown: includes every field exactly once", () => {
  const out = formatReporterContextMarkdown(SAMPLE);
  assertStringIncludes(out, SAMPLE.extensionName);
  assertStringIncludes(out, SAMPLE.extensionVersion);
  assertStringIncludes(out, SAMPLE.swampVersion);
  assertStringIncludes(out, SAMPLE.os);
  assertStringIncludes(out, SAMPLE.arch);
  assertStringIncludes(out, SAMPLE.denoVersion);
  assertStringIncludes(out, SAMPLE.shell);
});

Deno.test("formatReporterContextMarkdown: shell value with spaces is wrapped in backticks", () => {
  const ctx: ReporterContext = { ...SAMPLE, shell: "/my path/zsh" };
  const out = formatReporterContextMarkdown(ctx);
  assertStringIncludes(out, "- Shell: `/my path/zsh`");
});
