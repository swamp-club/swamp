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

// Architecture fitness rules for the affected-commands list the verification
// attestation carries (scripts/affected_commands.ts, scripts/command_index.ts).
//
// The unit tests pin the computation against hand-built graphs. These pin the
// two places it meets the real repository: the command tree it names commands
// from, and the directory layout its rule table was written against.

import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { ROOT } from "./arch_fitness_helpers.ts";
import {
  classifyOutsideGraph,
  COMMAND_DIR,
  ENTRY_POINT,
} from "../scripts/affected_commands.ts";
import {
  loadCommandIndex,
  UNEXPORTED_ROOTS,
} from "../scripts/command_index.ts";

/**
 * Command-directory files that are entry points of their own rather than part
 * of the CLI's module graph. The generator never hands these to the index —
 * it passes only files `deno info main.ts` reports — and this test must not
 * import them either: the dispatch runner reads stdin as soon as it loads.
 */
const SEPARATE_ENTRY_POINTS: ReadonlySet<string> = new Set([
  "worker_exec_dispatch_entry.ts",
]);

// This lists the directory, where the generator lists the command files
// `deno info main.ts` reports. The two agree while every file here that
// exports a command is one the CLI imports; a file outside the graph that
// re-exported a command object would be indexed here and not there.
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
  const index = await loadCommandIndex(ROOT, await commandFiles());

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

Deno.test("affected commands: each declared unexported root names a real command file", async () => {
  // The index throws on a root no file exports unless UNEXPORTED_ROOTS names
  // it, so the test above already proves the declaration is complete. This
  // proves it is not pointing at a file that has since moved.
  const files = await commandFiles();
  const index = await loadCommandIndex(ROOT, files);
  for (const [name, file] of Object.entries(UNEXPORTED_ROOTS)) {
    assert(files.includes(file), `${name} is declared in ${file}, not found`);
    assertEquals(index[name], file);
  }
});

/**
 * The top-level entries git tracks, each as a path a rule can be asked about.
 *
 * Asked of git rather than read from the directory: a checkout swamp is also
 * used in grows `vaults/`, `grants/` and other local state at its root, and a
 * rule about the repository's layout must not pass or fail on that.
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
  // A changed file no rule recognises selects every command. That is the safe
  // reading of a file nobody has classified, and a poor one for a whole new
  // directory: this fails when one appears, so the rule table in
  // scripts/affected_commands.ts is extended on purpose rather than every
  // change under it quietly reporting all commands.
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
