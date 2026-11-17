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

import { assertEquals, assertGreater } from "@std/assert";
import { walk } from "@std/fs/walk";
import { join, relative } from "@std/path";
import { callArguments, toPosixPath } from "./arch_fitness_helpers.ts";

const ROOT = join(import.meta.dirname!, "..");
const HOLD_CALL = /\bholdV3Writer\(/g;
const SERVE_OWNER = /ownerCheck:\s*\{\s*as:\s*"serve"/;
const SERVE_TTL = /\bttlMs:\s*SERVE_WRITER_LEASE_TTL_MS\b/;

async function serveHolds(): Promise<{ site: string; options: string }[]> {
  const holds: { site: string; options: string }[] = [];
  for await (
    const entry of walk(join(ROOT, "src"), {
      exts: [".ts", ".tsx"],
      skip: [/_test\.tsx?$/],
    })
  ) {
    const source = await Deno.readTextFile(entry.path);
    for (const match of source.matchAll(HOLD_CALL)) {
      const [, , options = ""] = callArguments(
        source,
        match.index! + match[0].length,
      );
      if (!SERVE_OWNER.test(options)) continue;
      const line = source.slice(0, match.index).split("\n").length;
      holds.push({
        site: `${toPosixPath(relative(ROOT, entry.path))}:${line}`,
        options,
      });
    }
  }
  return holds;
}

Deno.test("serve writer lease: every hold serve takes as owner asks for serve's TTL", async () => {
  const holds = await serveHolds();
  assertGreater(
    holds.length,
    0,
    "no serve-owned holds found; the rule is blind",
  );
  const missing = holds
    .filter((hold) => !SERVE_TTL.test(hold.options))
    .map((hold) => hold.site);
  assertEquals(
    missing,
    [],
    "Serve's leadership hold must pass ttlMs: SERVE_WRITER_LEASE_TTL_MS, or " +
      "a dead leader is taken over on the 30 s default and the shorter " +
      `takeover is silently lost.\n\nViolations:\n${missing.join("\n")}`,
  );
});
