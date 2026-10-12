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
import { resolve } from "@std/path";
import fc from "fast-check";
import {
  ALWAYS_LOCAL_SUBDIRS,
  DEFAULT_DATASTORE_SUBDIRS,
} from "../../domain/datastore/datastore_config.ts";
import { lexicalRefusal } from "../../domain/datastore_v3/materialisation.ts";
import { RecordKey } from "../../domain/datastore_v3/record_key.ts";
import { swampPath } from "../persistence/paths.ts";
import {
  readModelStateDir,
  refusedKeyReason,
  REPO_LOCAL_STREAM_SUBDIRS,
} from "./record_path_guard.ts";

// Paths are only resolved lexically: nothing here touches the filesystem.
const REPO = resolve("guard-property-repo");
const ROOT = swampPath(REPO);
const STATE = readModelStateDir(REPO);

const STREAMS: readonly string[] = REPO_LOCAL_STREAM_SUBDIRS;

// The synced set before swamp-club#3278 took the stream directories out.
const SYNCED_BEFORE: ReadonlySet<string> = new Set(
  DEFAULT_DATASTORE_SUBDIRS.filter((dir) =>
    !(ALWAYS_LOCAL_SUBDIRS as readonly string[]).includes(dir)
  ),
);

const arbSegment = fc.stringMatching(/^[A-Za-z0-9_.@-]{1,8}$/).filter((s) =>
  s !== "." && s !== ".."
);

const arbRest = fc.array(
  fc.oneof(arbSegment, fc.constantFrom("raw", "_catalog.db", "latest")),
  { minLength: 0, maxLength: 4 },
);

function refused(key: string): string | undefined {
  return refusedKeyReason(RecordKey.create(key), ROOT, STATE);
}

Deno.test("refusedKeyReason: refuses every key under a repo-local stream directory", () => {
  fc.assert(
    fc.property(fc.constantFrom(...STREAMS), arbRest, (dir, rest) => {
      const key = [dir, ...rest].join("/");
      assert(refused(key) !== undefined, `${key} was not refused`);
    }),
    { numRuns: 2000 },
  );
});

Deno.test("refusedKeyReason: answers every other key as before the stream directories left", () => {
  const firsts = [...DEFAULT_DATASTORE_SUBDIRS, ...ALWAYS_LOCAL_SUBDIRS]
    .filter((dir) => !STREAMS.includes(dir));
  fc.assert(
    fc.property(
      fc.oneof(fc.constantFrom(...firsts), arbSegment),
      arbRest,
      (first, rest) => {
        fc.pre(!STREAMS.includes(first));
        const key = [first, ...rest].join("/");
        assertEquals(refused(key), lexicalRefusal(key, SYNCED_BEFORE));
      },
    ),
    { numRuns: 2000 },
  );
});
