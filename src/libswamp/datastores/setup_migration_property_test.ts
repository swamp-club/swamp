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
import fc from "fast-check";
import {
  type FilesystemDatastoreConfig,
  getDatastoreDirectories,
  isRepoLocalStreamSubdir,
  isRunLogFile,
} from "../../domain/datastore/datastore_config.ts";
import {
  migrateDatastore,
  verifyMigration,
} from "../../domain/datastore/datastore_migration_service.ts";
import { createDatastoreSetupDeps } from "./setup.ts";

/** A file under a datastore subdir: `subdir/dirs.../name`. */
interface TreeFile {
  readonly subdir: string;
  readonly dirs: readonly string[];
  readonly name: string;
  readonly content: string;
}

const SUBDIRS = getDatastoreDirectories({ type: "filesystem", path: "/x" });

// Directory and file names never collide, so any set of files is a tree.
const arbFile: fc.Arbitrary<TreeFile> = fc.record({
  subdir: fc.constantFrom(...SUBDIRS),
  dirs: fc.array(fc.constantFrom("d1", "d2"), { maxLength: 2 }),
  name: fc.tuple(
    fc.constantFrom("f1", "f2", "workflow-run-r1"),
    fc.constantFrom(".log", ".yaml", ".json"),
  ).map(([base, ext]) => base + ext),
  content: fc.string({ maxLength: 16 }),
});

const arbTree = fc.uniqueArray(arbFile, {
  minLength: 1,
  maxLength: 12,
  selector: (f) => [f.subdir, ...f.dirs, f.name].join("/"),
});

function isRepoLocal(file: TreeFile): boolean {
  return isRepoLocalStreamSubdir(file.subdir) ||
    isRunLogFile(file.subdir, file.name);
}

async function readOrUndefined(path: string): Promise<string | undefined> {
  try {
    return await Deno.readTextFile(path);
  } catch {
    return undefined;
  }
}

Deno.test("datastore setup migration: every file either moves intact or stays repo-local and untouched", async () => {
  const seen = { moved: 0, kept: 0 };
  await fc.assert(
    fc.asyncProperty(arbTree, async (files) => {
      const tmp = await Deno.makeTempDir({ prefix: "swamp-setup-prop-" });
      try {
        const source = join(tmp, "source");
        const dest = join(tmp, "dest");
        for (const file of files) {
          const dir = join(source, file.subdir, ...file.dirs);
          await Deno.mkdir(dir, { recursive: true });
          await Deno.writeTextFile(join(dir, file.name), file.content);
        }
        const config: FilesystemDatastoreConfig = {
          type: "filesystem",
          path: dest,
        };

        const result = await migrateDatastore(source, dest, config);
        assertEquals(result.errors, []);
        const verification = await verifyMigration(source, dest, config);
        assert(verification.valid, JSON.stringify(verification));
        await createDatastoreSetupDeps(source, () => Promise.resolve(undefined))
          .cleanupSourceDirs(source, result.directoriesMigrated);

        for (const file of files) {
          const rel = [file.subdir, ...file.dirs, file.name];
          const atSource = await readOrUndefined(join(source, ...rel));
          const atDest = await readOrUndefined(join(dest, ...rel));
          if (isRepoLocal(file)) {
            seen.kept++;
            assertEquals(atSource, file.content, rel.join("/"));
            assertEquals(atDest, undefined, rel.join("/"));
          } else {
            seen.moved++;
            assertEquals(atDest, file.content, rel.join("/"));
            assertEquals(atSource, undefined, rel.join("/"));
          }
        }
      } finally {
        await Deno.remove(tmp, { recursive: true }).catch(() => {});
      }
    }),
    { numRuns: 50 },
  );
  // Both branches of the invariant were exercised.
  assert(seen.moved > 0 && seen.kept > 0, JSON.stringify(seen));
});
