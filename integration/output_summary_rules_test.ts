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
// A v3 recovery or a replica restore can put back the committed version of an
// output record whose later save its summary row already holds (swamp-club#4145).
// A row answers only while its record's stat matches, so such a row is not used,
// but whatever rewinds records still clears the output summaries after, whether or
// not it succeeded, as a second guard and to free their disk. These rules read the
// source: the restore branch needs a Litestream replica to reach.

import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  productionSourceFiles,
  repoRelative,
  SRC_DIR,
} from "./arch_fitness_helpers.ts";

function callsOf(code: string, name: string): number {
  return code.split("\n").filter((line) =>
    !line.trimStart().startsWith("*") &&
    !line.trimStart().startsWith("//") &&
    !line.includes(`function ${name}`) &&
    line.includes(`${name}(`)
  ).length;
}

Deno.test("every call of removeStaleRunIndexes is paired with removeStaleOutputSummaries", async () => {
  const unpaired: string[] = [];
  let sites = 0;
  for await (const file of productionSourceFiles(SRC_DIR)) {
    const code = await Deno.readTextFile(file);
    const calls = callsOf(code, "removeStaleRunIndexes");
    if (calls === 0) continue;
    sites += calls;
    if (callsOf(code, "removeStaleOutputSummaries") < calls) {
      unpaired.push(repoRelative(file));
    }
  }
  assertEquals(unpaired, []);
  // The rule stays meaningful: the recovery sites are still there to check.
  assertEquals(sites >= 5, true);
});

Deno.test("every direct recovery of a v3 handle is in a file that clears the output summaries", async () => {
  const uncleared: string[] = [];
  const recoveries = /\.recover(?:InterruptedWriter|DroppedWork)\(/;
  let sites = 0;
  for await (const file of productionSourceFiles(SRC_DIR)) {
    const code = await Deno.readTextFile(file);
    if (!recoveries.test(code)) continue;
    sites++;
    if (callsOf(code, "removeStaleOutputSummaries") === 0) {
      uncleared.push(repoRelative(file));
    }
  }
  assertEquals(uncleared, []);
  assertEquals(sites >= 3, true);
});

Deno.test("a restore that moves the read model clears the output summaries before its replay and in a finally, on both its paths", async () => {
  const code = await Deno.readTextFile(
    join(SRC_DIR, "infrastructure/datastore_v3/v3_repo_context.ts"),
  );
  const start = code.indexOf("if (refresh.restored.readModelMoved) {");
  assertEquals(start >= 0, true);
  const branch = code.slice(start, code.indexOf("} else if (handle", start));
  const finallyAt = branch.lastIndexOf("} finally {");
  assertEquals(finallyAt >= 0, true);
  for (const path of ["recoverInterruptedWriter(0)", "rebuilt.catchUp()"]) {
    const at = branch.indexOf(path);
    assertEquals(at >= 0 && at < finallyAt, true, path);
  }
  assertEquals(
    branch.lastIndexOf("removeStaleOutputSummaries(repoDir)") > finallyAt,
    true,
  );
  // And before them: a process killed during the replay never reaches finally,
  // and this branch does not run again once the copy state names the restore.
  const replayAt = Math.min(
    branch.indexOf("recoverInterruptedWriter(0)"),
    branch.indexOf("rebuilt.catchUp()"),
  );
  const firstClear = branch.indexOf("removeStaleOutputSummaries(repoDir)");
  assertEquals(firstClear >= 0 && firstClear < replayAt, true);
});
