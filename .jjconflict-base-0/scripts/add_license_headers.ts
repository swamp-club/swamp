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

import { walk } from "@std/fs/walk";
import { join } from "@std/path";

const HEADER = `// Swamp, an Automation Framework
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
`;

const HEADER_MARKER = "// Swamp, an Automation Framework";

const ROOT = Deno.cwd();

const SKIP_DIRS = new Set([
  "experiments",
  ".agents",
  ".claude",
  ".github",
  ".jj",
  "node_modules",
  ".git",
]);

async function collectFiles(): Promise<string[]> {
  const files: string[] = [];

  // Walk src/, integration/, scripts/
  for (const dir of ["src", "integration", "scripts"]) {
    const dirPath = join(ROOT, dir);
    try {
      for await (
        const entry of walk(dirPath, {
          exts: [".ts", ".tsx"],
          includeDirs: false,
          skip: [...SKIP_DIRS].map((d) => new RegExp(`(^|/)${d}(/|$)`)),
        })
      ) {
        files.push(entry.path);
      }
    } catch (err) {
      if (!(err instanceof Deno.errors.NotFound)) {
        throw err;
      }
    }
  }

  // Root-level .ts/.tsx files
  for await (const entry of Deno.readDir(ROOT)) {
    if (
      entry.isFile &&
      (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx"))
    ) {
      files.push(join(ROOT, entry.name));
    }
  }

  return files.sort();
}

async function addHeader(filePath: string): Promise<boolean> {
  const content = await Deno.readTextFile(filePath);

  // Skip if header already present (may be after a shebang line)
  if (content.includes(HEADER_MARKER)) {
    return false;
  }

  // Handle shebang lines
  let newContent: string;
  if (content.startsWith("#!")) {
    const newlineIdx = content.indexOf("\n");
    const shebang = content.slice(0, newlineIdx + 1);
    const rest = content.slice(newlineIdx + 1);
    newContent = shebang + "\n" + HEADER + "\n" + rest;
  } else {
    newContent = HEADER + "\n" + content;
  }

  await Deno.writeTextFile(filePath, newContent);
  return true;
}

async function main() {
  const files = await collectFiles();
  let added = 0;
  let skipped = 0;

  for (const file of files) {
    const wasAdded = await addHeader(file);
    if (wasAdded) {
      added++;
      console.log(`Added header: ${file}`);
    } else {
      skipped++;
    }
  }

  console.log(
    `\nDone. Added headers to ${added} files, skipped ${skipped} (already had header).`,
  );
}

main();
