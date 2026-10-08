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
 * Direct readers of data content files (swamp-club#3178).
 *
 * On a lazily hydrating datastore the cache can hold a version's metadata
 * without its content, or content older than the metadata. Every read is
 * meant to go through the repository's content-ensuring step:
 * `getContent`, `stream` or `ensureContentLocal`. A reader that opens the
 * file itself, or reads it with the synchronous `getContentSync`, sees
 * nothing or stale bytes. These rules pin the readers that do, so a new one
 * fails here instead of waiting for a review to find it.
 *
 * Not seen here: paths that leave core as values — `DataRecord.path` and
 * `FileDataRecord.path`, read by `file.contents`, by users and by shell
 * commands, and content paths handed to extension code.
 */

import {
  assertPinnedSet,
  isCommentLine,
  productionSourceFiles,
  repoRelative,
  SRC_DIR,
  TOP_LEVEL_DECLARATION,
} from "./arch_fitness_helpers.ts";

/** A method declared directly in a class body. */
const METHOD_DECLARATION =
  /^ {2}(?:(?:private|public|protected|static|async|override|get|set)\s+)*(?:\*\s*)?(\w+)\s*[(<]/;

const KEYWORDS = new Set(["if", "for", "while", "switch", "return", "catch"]);

/**
 * The function or method that contains each line: a top-level declaration,
 * narrowed for a class to the method declared in its body.
 */
function enclosingUnits(lines: readonly string[]): string[] {
  let owner = "<module>";
  let inClass = false;
  let method = "";
  return lines.map((line) => {
    const top = line.match(TOP_LEVEL_DECLARATION);
    if (top) {
      owner = top[1];
      inClass = /^(?:export )?(?:abstract )?class /.test(line);
      method = "";
    } else if (inClass) {
      const declared = line.match(METHOD_DECLARATION);
      if (declared && !KEYWORDS.has(declared[1])) method = declared[1];
    }
    return method ? `${owner}.${method}` : owner;
  });
}

interface Scan {
  syncReaders: string[];
  contentPathReaders: string[];
}

async function scan(): Promise<Scan> {
  const syncReaders = new Set<string>();
  const unitsCallingPath = new Set<string>();
  const unitsReadingFiles = new Set<string>();
  for await (const filePath of productionSourceFiles(SRC_DIR)) {
    const rel = repoRelative(filePath);
    const lines = (await Deno.readTextFile(filePath)).split("\n");
    const units = enclosingUnits(lines);
    lines.forEach((line, i) => {
      if (isCommentLine(line)) return;
      const unit = `${rel}#${units[i]}`;
      if (/\.getContentSync\(/.test(line)) syncReaders.add(unit);
      if (/\.getContentPath\(/.test(line)) unitsCallingPath.add(unit);
      if (
        /\bDeno\.(?:readFile|readFileSync|readTextFile|readTextFileSync|open|openSync)\(/
          .test(line)
      ) unitsReadingFiles.add(unit);
    });
  }
  return {
    syncReaders: [...syncReaders].sort(),
    contentPathReaders: [...unitsCallingPath]
      .filter((unit) => unitsReadingFiles.has(unit))
      .sort(),
  };
}

const POLICY =
  "A new direct reader of data content skips the content-ensuring " +
  "step, so on a lazily hydrating datastore it reads nothing or stale " +
  "bytes (swamp-club#3178). Read through getContent or stream, or call " +
  "ensureContentLocal before a synchronous read. If the read is safe " +
  "without it (the content is known to be local and current), say why in " +
  "a comment at the call and add it to the pinned list.";

/**
 * Callers of the synchronous content read, which cannot hydrate. Each is
 * preceded by an ensuring step, reports what it could not read, or is a
 * documented limitation.
 */
const PINNED_SYNC_READERS: readonly string[] = [
  // Delegates to the ephemeral or persistent repository.
  "src/domain/data/composite_data_repository.ts#CompositeUnifiedDataRepository.getContentSync",
  // The querySync projection path, behind data.query() in a synchronous CEL
  // context; documented as unable to download.
  "src/domain/data/data_query_service.ts#DataQueryService.projectedContent",
  // Reports a missing or short body, which the async query downloads.
  "src/domain/data/data_record_mapper.ts#fromRow",
  // Runs after prepare (the model map) or ensureContentLocal (data.latest).
  "src/domain/expressions/model_resolver.ts#ModelResolver.dataToRecord",
  // In-memory content is always complete.
  "src/infrastructure/persistence/in_memory_data_repository.ts#InMemoryUnifiedDataRepository.ensureContentLocal",
  "src/infrastructure/persistence/in_memory_data_repository.ts#InMemoryUnifiedDataRepository.getContent",
  "src/infrastructure/persistence/in_memory_data_repository.ts#InMemoryUnifiedDataRepository.stream",
];

/**
 * Functions that open a content file by its path themselves: the
 * filesystem repository's readers, behind its ensuring step, its writers,
 * and the synchronous read itself.
 */
const PINNED_CONTENT_PATH_READERS: readonly string[] = [
  "src/infrastructure/persistence/unified_data_repository.ts#FileSystemUnifiedDataRepository.append",
  "src/infrastructure/persistence/unified_data_repository.ts#FileSystemUnifiedDataRepository.finalizeVersion",
  "src/infrastructure/persistence/unified_data_repository.ts#FileSystemUnifiedDataRepository.finalizeVersionDeferred",
  "src/infrastructure/persistence/unified_data_repository.ts#FileSystemUnifiedDataRepository.getContent",
  "src/infrastructure/persistence/unified_data_repository.ts#FileSystemUnifiedDataRepository.getContentSync",
  "src/infrastructure/persistence/unified_data_repository.ts#FileSystemUnifiedDataRepository.stream",
];

Deno.test("content readers: getContentSync callers are pinned", async () => {
  const { syncReaders } = await scan();
  assertPinnedSet(
    syncReaders,
    PINNED_SYNC_READERS,
    "getContentSync callers",
    POLICY,
  );
});

Deno.test("content readers: functions that open a content path are pinned", async () => {
  const { contentPathReaders } = await scan();
  assertPinnedSet(
    contentPathReaders,
    PINNED_CONTENT_PATH_READERS,
    "content path readers",
    POLICY,
  );
});
