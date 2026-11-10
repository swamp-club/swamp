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

import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { ROOT } from "./arch_fitness_helpers.ts";
import {
  classifyOutsideGraph,
  COMMAND_DIR,
  ENTRY_POINT,
} from "../scripts/affected_commands.ts";
import { loadCommandIndex, UNROUTED_ROOTS } from "../scripts/command_index.ts";

/**
 * entry points of their own, not part of the CLI module graph; the index never
 * gets them and this test must not import them, since the dispatch runner reads
 * stdin on load
 */
const SEPARATE_ENTRY_POINTS: ReadonlySet<string> = new Set([
  "worker_exec_dispatch_entry.ts",
]);

// lists the directory where the generator lists files from the module graph;
// they agree only while every file exporting a command is one the CLI imports
async function commandFiles(): Promise<string[]> {
  const files: string[] = [];
  for await (const entry of Deno.readDir(join(ROOT, COMMAND_DIR))) {
    if (!entry.isFile || !/\.tsx?$/.test(entry.name)) continue;
    if (SEPARATE_ENTRY_POINTS.has(entry.name)) continue;
    const path = `${COMMAND_DIR}${entry.name}`;
    if (classifyOutsideGraph(path).rule === "test") continue;
    files.push(path);
  }
  return files.sort();
}

Deno.test("affected commands: every root command maps to a file that exists", async () => {
  const index = loadCommandIndex(await commandFiles());

  // Load-bearing: an index that came back empty would make every assertion
  // below pass over nothing.
  const names = Object.keys(index);
  assert(names.length >= 20, `only ${names.length} root commands indexed`);
  for (const expected of ["vault", "serve", "model", "workflow", "help"]) {
    assert(names.includes(expected), `${expected} is missing from the index`);
  }

  for (const [name, file] of Object.entries(index)) {
    assert(file.startsWith(COMMAND_DIR), `${name} maps outside ${COMMAND_DIR}`);
    const stat = await Deno.stat(join(ROOT, file));
    assert(stat.isFile, `${name} maps to ${file}, which is not a file`);
  }
});

Deno.test("affected commands: each declared unrouted root names a real command file", async () => {
  const files = await commandFiles();
  const index = loadCommandIndex(files);
  for (const [name, file] of Object.entries(UNROUTED_ROOTS)) {
    assert(files.includes(file), `${name} is declared in ${file}, not found`);
    assertEquals(index[name], file);
  }
});

/**
 * asked of git, not the directory: a checkout grows local state like vaults/ at
 * its root, and a layout rule must not pass or fail on that
 */
async function trackedTopLevelSamples(): Promise<string[]> {
  const { code, stdout } = await new Deno.Command("git", {
    args: ["ls-files", "-z"],
    cwd: ROOT,
    stdout: "piped",
    stderr: "null",
  }).output();
  assertEquals(code, 0, "git ls-files failed");
  const samples = new Map<string, string>();
  for (const file of new TextDecoder().decode(stdout).split("\0")) {
    if (file === "") continue;
    const top = file.split("/")[0];
    if (!samples.has(top)) samples.set(top, file);
  }
  return [...samples.values()];
}

Deno.test("affected commands: every top-level path has an explicit rule", async () => {
  // an unrecognised file selects every command, a poor outcome for a new
  // directory; this fails so the rule table is extended on purpose
  const samples = (await trackedTopLevelSamples())
    // The module graph itself: files here are looked up in it, not in the
    // rule table.
    .filter((file) => !file.startsWith("src/") && file !== ENTRY_POINT);

  assert(samples.length >= 20, `only ${samples.length} top-level paths found`);
  assertEquals(
    samples
      .filter((file) => classifyOutsideGraph(file).rule === "unclassified")
      .map((file) => file.split("/")[0])
      .sort(),
    [],
    "These top-level paths match no rule in scripts/affected_commands.ts, " +
      "so any change under them reports every command as affected. Add " +
      "each to the rule table with the effect it really has.",
  );
});
