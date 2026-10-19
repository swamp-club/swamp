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

// Architectural fitness test: only swamp writes `_swamp.*` tags.
//
// Readers trust tags under the `_swamp.` prefix as swamp's own:
// `_swamp.sensitiveFields` chooses which fields of a record resolve vault
// references. swamp-club#3635 made the data writers and the method execution
// service refuse a user-supplied key under the prefix, so the vaulting step is
// the only way one reaches a record. A new file that spells a reserved key as
// a string literal is a new writer of a trusted tag, and must be reviewed as
// one.
//
// The rule looks for string literals that begin with the prefix, on lines
// that are not comments, so prose that mentions a tag in a doc comment is not
// caught.

import { assertEquals } from "@std/assert";
import { relative } from "@std/path";
import {
  isCommentLine,
  productionSourceFiles,
  ROOT,
  SRC_DIR,
  toPosixPath,
} from "./arch_fitness_helpers.ts";

/** Files allowed to spell a reserved tag key, and why each one is there. */
const PINNED_RESERVED_TAG_WRITERS = [
  // RESERVED_TAG_PREFIX, the rule itself.
  "src/domain/data/data.ts",
  // SENSITIVE_FIELDS_TAG, set only after vaulting.
  "src/domain/models/data_writer.ts",
];

const RESERVED_TAG_LITERAL = /(["'`])_swamp\./;

Deno.test("reserved tags: only data.ts and data_writer.ts spell a _swamp. tag key", async () => {
  const writers: string[] = [];
  for await (const path of productionSourceFiles(SRC_DIR)) {
    const source = await Deno.readTextFile(path);
    const spells = source.split("\n").some((line) =>
      !isCommentLine(line) && RESERVED_TAG_LITERAL.test(line)
    );
    if (spells) writers.push(toPosixPath(relative(ROOT, path)));
  }

  assertEquals(
    writers.sort(),
    [...PINNED_RESERVED_TAG_WRITERS].sort(),
    "a production file spells a tag key under the reserved '_swamp.' prefix " +
      "as a string literal. Readers trust these tags as swamp's own " +
      "(swamp-club#3635). Use RESERVED_TAG_PREFIX or SENSITIVE_FIELDS_TAG, " +
      "or, for a genuinely new swamp-written tag, define it beside " +
      "SENSITIVE_FIELDS_TAG in src/domain/models/data_writer.ts and pin it here.",
  );
});
