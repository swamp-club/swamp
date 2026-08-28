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

/**
 * Splice the Mermaid generated from design/architecture/*.c4 into
 * design/architecture.md.
 *
 * architecture.md carries marker pairs:
 *
 *   <!-- diagram: context -->
 *   ...replaced...
 *   <!-- /diagram -->
 *
 * Each marker names a view id; the matching
 * design/architecture/generated/<id>.mmd is dropped in as a ```mermaid fence
 * (its YAML front-matter title stripped) so GitHub renders it inline.
 *
 * Usage: deno run --allow-read --allow-write scripts/splice_diagrams.ts [--check]
 * With --check the file is not written; exit code 1 means it is stale.
 */

const DOC = "design/architecture.md";
const GENERATED = "design/architecture/generated";
const check = Deno.args.includes("--check");

const marker = /<!-- diagram: ([\w-]+) -->\n[\s\S]*?<!-- \/diagram -->/g;

function stripFrontMatter(mmd: string): string {
  return mmd.replace(/^---\n[\s\S]*?\n---\n/, "").trim();
}

const before = await Deno.readTextFile(DOC);
const missing: string[] = [];
const after = before.replace(marker, (_m, id: string) => {
  let mmd: string;
  try {
    mmd = Deno.readTextFileSync(`${GENERATED}/${id}.mmd`);
  } catch {
    missing.push(id);
    return _m;
  }
  return `<!-- diagram: ${id} -->\n\`\`\`mermaid\n${
    stripFrontMatter(mmd)
  }\n\`\`\`\n<!-- /diagram -->`;
});

if (missing.length > 0) {
  console.error(`no generated diagram for view(s): ${missing.join(", ")}`);
  Deno.exit(1);
}

if (after === before) {
  console.log(`${DOC} is up to date`);
  Deno.exit(0);
}
if (check) {
  console.error(`${DOC} is stale — run \`deno task diagrams:render\``);
  Deno.exit(1);
}
await Deno.writeTextFile(DOC, after);
console.log(`${DOC} updated`);
