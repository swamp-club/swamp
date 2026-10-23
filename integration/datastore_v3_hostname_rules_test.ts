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
 * Pins every `Deno.hostname()` call in v3 datastore code (swamp-club#3801).
 * A hostname changes under a running process (a DHCP renewal on macOS), so
 * v3 judges "this machine" and "this process's own record" by process
 * identity: boot id, pid namespace, pid and start time. The hostname is
 * written into records for display, and judges only records from a swamp
 * before identities. A new call is either one of those, or a comparison
 * that would block writes after a rename.
 */

import { join } from "@std/path";
import {
  assertPinnedSet,
  countedKeys,
  isCommentLine,
  productionSourceFiles,
  repoRelative,
  SRC_DIR,
  topLevelOwners,
} from "./arch_fitness_helpers.ts";

/** `<file> :: <top-level owner>`, counted, for each call. */
const PINNED = [
  // Written into records and display strings.
  "src/infrastructure/datastore_v3/interrupted_writer_recovery.ts :: writeWriterMarker",
  "src/infrastructure/datastore_v3/litestream/replication_supervisor.ts :: superviseHeld",
  "src/infrastructure/datastore_v3/litestream/v3_copy.ts :: holderName",
  "src/infrastructure/datastore_v3/process_identity.ts :: hostnameOf",
  "src/infrastructure/datastore_v3/process_identity.ts :: localProcess",
  "src/infrastructure/datastore_v3/v3_datastore.ts :: processCommitWriter",
  "src/infrastructure/datastore_v3/v3_repo_context.ts :: recordWriterCheckout",
  "src/infrastructure/datastore_v3/v3_writer_lock.ts :: v3WriterLease",
  // Records from a swamp before process identities, judged as they were.
  "src/infrastructure/datastore_v3/v3_repo_context.ts :: legacyWriterWritesCheckout",
  "src/infrastructure/datastore_v3/v3_writer_lock.ts :: refuseLiveV3LegacyWriter",
];

Deno.test("datastore v3: every Deno.hostname() call writes a record or judges a pre-identity one (swamp-club#3801)", async () => {
  const keys: string[] = [];
  for (
    const dir of [
      join(SRC_DIR, "infrastructure", "datastore_v3"),
      join(SRC_DIR, "domain", "datastore_v3"),
    ]
  ) {
    for await (const file of productionSourceFiles(dir)) {
      // Test helpers plant records as another process would.
      if (file.endsWith("_test_helpers.ts")) continue;
      const lines = (await Deno.readTextFile(file)).split("\n");
      const owners = topLevelOwners(lines);
      lines.forEach((line, i) => {
        if (isCommentLine(line)) return;
        for (const _ of line.matchAll(/Deno\.hostname\(\)/g)) {
          keys.push(`${repoRelative(file)} :: ${owners[i]}`);
        }
      });
    }
  }
  assertPinnedSet(
    countedKeys(keys.sort()),
    PINNED,
    "Deno.hostname() in v3 datastore code",
    "Judge whether a record is this machine's or this process's by its " +
      "process identity (sameKernel / judgeRecordedProcess in " +
      "src/domain/datastore_v3/process_liveness.ts), never by comparing " +
      "hostnames. A hostname written into a record for display is fine: " +
      "pin it here.",
  );
});
