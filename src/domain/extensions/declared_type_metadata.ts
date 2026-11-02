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

import { dirname } from "@std/path";

export interface DeclaredTypeMetadata {
  name: string;
  description: string;
}

/**
 * nothing is imported or run; undefined when the source is unreadable, the
 * extractor throws or finds no definition, or it defines a different type; a
 * computed field comes back empty
 */
export async function readDeclaredTypeMetadata(
  entry: { type: string; sourcePath: string },
  extract: (
    source: string,
    filePath: string,
    baseDir: string,
  ) => { type: string; name: string; description: string } | null,
  readSource: (path: string) => Promise<string> = (path) =>
    Deno.readTextFile(path),
): Promise<DeclaredTypeMetadata | undefined> {
  let extracted: ReturnType<typeof extract>;
  try {
    const source = await readSource(entry.sourcePath);
    extracted = extract(source, entry.sourcePath, dirname(entry.sourcePath));
  } catch {
    return undefined;
  }
  if (!extracted) return undefined;
  if (extracted.type.toLowerCase() !== entry.type.toLowerCase()) {
    return undefined;
  }
  return { name: extracted.name, description: extracted.description };
}
