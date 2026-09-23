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

// Architectural fitness test: the two invariants behind swamp's colour policy.
//
// 1. swamp and Cliffy must share one `@std/fmt` instance. Colour is module
//    state, so the whole reason `applyColorPolicy` can clean up `--version` and
//    `--help` is that flipping swamp's flag flips the one Cliffy reads. Two
//    resolved copies would restore swamp-club#2414 silently — no unit test can
//    see it, because the bug only exists in a process Cliffy has parsed.
// 2. Colour is disabled from a known, small set of places, and never enabled.
//    `@std/fmt` applies `NO_COLOR` itself at load; code that calls
//    `setColorEnabled(true)` overrides a disable it did not make.
//
// Both lists are pinned deliberately: a new entry should be a deliberate
// decision, not a silent one.

import { assertEquals } from "@std/assert";
import { join, relative } from "@std/path";
import {
  productionSourceFiles,
  repoRelative,
  ROOT,
  SRC_DIR,
  toPosixPath,
} from "./arch_fitness_helpers.ts";

const LOCKFILE = join(ROOT, "deno.lock");

/** Files allowed to reach for the colour switch, and why each one is there. */
const PINNED_COLOUR_CALLERS = [
  // The policy itself: one decision, applied before Cliffy parses.
  "src/cli/context.ts",
  // stdout is the dispatch protocol in this process; see the file header.
  "src/cli/commands/worker_exec_dispatch_entry.ts",
];

Deno.test("colour policy: deno.lock resolves @std/fmt to exactly one version", async () => {
  const lock = JSON.parse(await Deno.readTextFile(LOCKFILE)) as {
    jsr?: Record<string, unknown>;
  };
  const resolved = Object.keys(lock.jsr ?? {})
    .filter((key) => key.startsWith("@std/fmt@"))
    .sort();

  assertEquals(
    resolved.length,
    1,
    `${
      repoRelative(LOCKFILE)
    } resolves @std/fmt to ${resolved.length} versions (${
      resolved.join(", ")
    }). swamp's colour policy works by flipping @std/fmt's module-level colour ` +
      `flag before Cliffy parses --version and --help, which only reaches ` +
      `Cliffy while both resolve to the same copy. Two copies give Cliffy its ` +
      `own flag and bring back swamp-club#2414 with every test still passing. ` +
      `Align the ranges (deno.json and Cliffy's own dependency) onto one ` +
      `version rather than deleting this assertion.`,
  );
});

Deno.test("colour policy: only the pinned files disable colour, and nothing enables it", async () => {
  const disablers: string[] = [];
  const enablers: string[] = [];

  for await (const path of productionSourceFiles(SRC_DIR)) {
    const source = await Deno.readTextFile(path);
    const rel = toPosixPath(relative(ROOT, path));

    // Go by the import, not by any mention of the name. Two reasons: context.ts
    // hands `setColorEnabled` to `applyColorPolicy` as its default effect
    // rather than calling it inline, so a call-site scan misses it; and prose
    // naming the symbol — mod.ts explains Cliffy's help generator in a comment
    // — is not a second decision point, so a plain text scan over-reports.
    const importsSwitch = [
      ...source.matchAll(/import\s*\{([^}]*)\}\s*from\s*"@std\/fmt\/colors"/g),
    ].some((m) => /\bsetColorEnabled\b/.test(m[1]));
    if (!importsSwitch) continue;
    disablers.push(rel);
    // A call with anything but `false`. Read the argument out rather than
    // asking a lookahead: `(?!false)` after `\s*` lets the whitespace
    // backtrack, and `setColorEnabled( false )` slips through as an enabler.
    for (const call of source.matchAll(/setColorEnabled\(([^)]*)\)/g)) {
      if (call[1].trim() !== "false") {
        enablers.push(rel);
        break;
      }
    }
  }

  assertEquals(
    disablers.sort(),
    [...PINNED_COLOUR_CALLERS].sort(),
    "the set of production files that touch the colour switch has changed. " +
      "Colour is " +
      "decided once, in src/cli/context.ts, early enough to reach Cliffy's " +
      "own output (swamp-club#2414). A new caller means a second decision " +
      "point that can disagree with the first — add it here only once you are " +
      "sure it needs one.",
  );

  assertEquals(
    enablers,
    [],
    `production code must never enable colour: ${
      enablers.join(", ")
    }. @std/fmt has already applied NO_COLOR by the time swamp runs, so ` +
      `setColorEnabled with anything but false overrides a disable this ` +
      `codebase did not make. Tests may toggle it, but should restore the ` +
      `previous value read from getColorEnabled().`,
  );
});
