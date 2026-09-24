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

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { initializeLogging } from "../../infrastructure/logging/logger.ts";
import { createExtensionPullRenderer } from "./extension_pull.ts";

await initializeLogging({});

/** Captures everything written through console.log/info/warn. */
function captureConsole(fn: () => void): string {
  const original = {
    log: console.log,
    info: console.info,
    warn: console.warn,
  };
  const lines: string[] = [];
  const capture = (...args: unknown[]) => {
    lines.push(
      args.map((a) => typeof a === "string" ? a : String(a)).join(" "),
    );
  };
  console.log = capture;
  console.info = capture;
  console.warn = capture;
  try {
    fn();
  } finally {
    console.log = original.log;
    console.info = original.info;
    console.warn = original.warn;
  }
  return lines.join("\n");
}

const FILE = ".swamp/pulled-extensions/@test/ext/models/a.ts";
const SKILL = ".claude/skills/foo";

Deno.test("createExtensionPullRenderer: log mode lists skill dirs apart from overwritten files", () => {
  const renderer = createExtensionPullRenderer("log");
  const out = captureConsole(() => {
    renderer.renderConflicts([FILE, SKILL], [SKILL]);
  });
  assertStringIncludes(out, "already exist and will be overwritten");
  assertStringIncludes(out, "skill directories already exist");
  assertStringIncludes(out, "other files are kept");
  const overwriteSection = out.split("skill directories")[0];
  assertStringIncludes(overwriteSection, FILE);
  assert(!overwriteSection.includes(SKILL));
});

Deno.test("createExtensionPullRenderer: log mode without skill dirs prints only the file list", () => {
  const renderer = createExtensionPullRenderer("log");
  const out = captureConsole(() => {
    renderer.renderConflicts([FILE]);
  });
  assertStringIncludes(out, FILE);
  assert(!out.includes("skill directories"));
});

Deno.test("createExtensionPullRenderer: json mode adds skillDirs only when present", () => {
  const renderer = createExtensionPullRenderer("json");
  const withSkills = JSON.parse(captureConsole(() => {
    renderer.renderConflicts([FILE, SKILL], [SKILL]);
  }));
  assertEquals(withSkills, { conflicts: [FILE, SKILL], skillDirs: [SKILL] });
  const withoutSkills = JSON.parse(captureConsole(() => {
    renderer.renderConflicts([FILE]);
  }));
  assertEquals(withoutSkills, { conflicts: [FILE] });
});
