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

import { walk } from "@std/fs/walk";
import { join, relative, SEPARATOR } from "@std/path";

export const HEADER = `// Swamp, an Automation Framework
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
`;

const MARKER_TEXT = "Swamp, an Automation Framework";

const HEADER_LINES = HEADER.slice(0, -1).split("\n");

const ROOT = Deno.cwd();

export const LICENSED_DIRS = [
  "src",
  "integration",
  "scripts",
  "extensions",
  "packages",
];

const SKIP_DIRS = new Set([
  "experiments",
  ".agents",
  ".claude",
  ".github",
  ".jj",
  "node_modules",
  ".git",
]);

function isSkipped(repoRelativePath: string): boolean {
  return repoRelativePath.split(SEPARATOR).some((segment) =>
    SKIP_DIRS.has(segment)
  );
}

export async function collectFiles(root = ROOT): Promise<string[]> {
  const files: string[] = [];

  for (const dir of LICENSED_DIRS) {
    const dirPath = join(root, dir);
    try {
      for await (
        const entry of walk(dirPath, {
          exts: [".ts", ".tsx"],
          includeDirs: false,
        })
      ) {
        if (isSkipped(relative(root, entry.path))) continue;
        files.push(entry.path);
      }
    } catch (err) {
      if (!(err instanceof Deno.errors.NotFound)) {
        throw err;
      }
    }
  }

  for await (const entry of Deno.readDir(root)) {
    if (
      entry.isFile &&
      (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx"))
    ) {
      files.push(join(root, entry.name));
    }
  }

  return files.sort();
}

export type HeaderStatus = "ok" | "missing" | "malformed";

export type HeaderResult =
  | { kind: "unchanged"; content: string }
  | { kind: "added"; content: string }
  | { kind: "repaired"; content: string }
  | { kind: "unrepairable"; content: string };

// A prepended header leaves one blank line between the shebang and the header.
function splitShebang(content: string): { prefix: string; rest: string } {
  if (!content.startsWith("#!")) return { prefix: "", rest: content };
  const newlineIdx = content.indexOf("\n");
  if (newlineIdx === -1) return { prefix: content, rest: "" };
  let end = newlineIdx + 1;
  if (content[end] === "\n") end++;
  return { prefix: content.slice(0, end), rest: content.slice(end) };
}

function normalizeLine(line: string): string {
  return line.replaceAll("\\/", "/").trimEnd();
}

export function headerStatus(content: string): HeaderStatus {
  const { rest } = splitShebang(content);
  if (rest.startsWith(HEADER)) return "ok";
  // Anywhere, not just the top: prepending above a displaced header stacks two.
  return rest.includes(MARKER_TEXT) ? "malformed" : "missing";
}

export function applyHeader(content: string): HeaderResult {
  const status = headerStatus(content);
  if (status === "ok") return { kind: "unchanged", content };

  if (status === "missing") {
    if (!content.startsWith("#!")) {
      return { kind: "added", content: HEADER + "\n" + content };
    }
    const newlineIdx = content.indexOf("\n");
    const shebang = newlineIdx === -1
      ? content + "\n"
      : content.slice(0, newlineIdx + 1);
    const rest = newlineIdx === -1 ? "" : content.slice(newlineIdx + 1);
    return { kind: "added", content: shebang + "\n" + HEADER + "\n" + rest };
  }

  const { prefix, rest } = splitShebang(content);
  const lines = rest.split("\n");
  let matched = 0;
  while (
    matched < HEADER_LINES.length && matched < lines.length &&
    normalizeLine(lines[matched]) === HEADER_LINES[matched]
  ) {
    matched++;
  }

  // A // line after the matched run could be damaged header text or a real
  // comment; rewriting either guess risks a stacked header or a lost comment.
  const next = lines[matched];
  if (
    matched === 0 ||
    (matched < HEADER_LINES.length && next !== undefined &&
      next.startsWith("//"))
  ) {
    return { kind: "unrepairable", content };
  }

  const body = lines.slice(matched);
  while (body.length > 0 && body[0].trim() === "") body.shift();
  const repaired = body.length === 0
    ? prefix + HEADER
    : prefix + HEADER + "\n" + body.join("\n");
  return { kind: "repaired", content: repaired };
}

async function main() {
  const files = await collectFiles();
  let added = 0;
  let repaired = 0;
  let unchanged = 0;
  const unrepairable: string[] = [];

  for (const file of files) {
    const result = applyHeader(await Deno.readTextFile(file));
    switch (result.kind) {
      case "unchanged":
        unchanged++;
        break;
      case "unrepairable":
        unrepairable.push(file);
        break;
      case "added":
        await Deno.writeTextFile(file, result.content);
        added++;
        console.log(`Added header: ${file}`);
        break;
      case "repaired":
        await Deno.writeTextFile(file, result.content);
        repaired++;
        console.log(`Repaired header: ${file}`);
        break;
    }
  }

  console.log(
    `\nDone. Added headers to ${added} files, repaired ${repaired}, ${unchanged} already correct.`,
  );

  if (unrepairable.length > 0) {
    console.error(
      `\n${unrepairable.length} file(s) have a malformed header this script cannot repair safely. ` +
        `Fix them by hand against HEADER in scripts/add_license_headers.ts:\n` +
        unrepairable.map((f) => `  - ${f}`).join("\n"),
    );
    Deno.exit(1);
  }
}

if (import.meta.main) {
  await main();
}
