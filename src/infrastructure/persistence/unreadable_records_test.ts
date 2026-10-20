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

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { errorPaths } from "../../domain/errors.ts";
import {
  mayBeUnreadableError,
  unreadableRecordsUnder,
  warnUnreadableLeftOut,
} from "./unreadable_records.ts";
import {
  captureUnreadableWarnings,
  FAKE_ADVICE,
  fakeUnreadableLookup,
} from "./unreadable_records_test_helpers.ts";

function scratchDir(): string {
  return join(Deno.cwd(), `.no-such-${crypto.randomUUID()}`);
}

Deno.test("warnUnreadableLeftOut: one warning names every unreadable record under the directory and its advice, once per process", async () => {
  const dir = scratchDir();
  const a = join(dir, "w1", "workflow-run-a.yaml");
  const b = join(dir, "w2", "workflow-run-b.yaml");
  const outside = join(`${dir}-other`, "workflow-run-c.yaml");
  const { lookup, stats } = fakeUnreadableLookup([a, b, outside]);
  const warnings = await captureUnreadableWarnings(async () => {
    await warnUnreadableLeftOut(lookup, dir);
    await warnUnreadableLeftOut(lookup, dir);
  });
  assertEquals(warnings.length, 1, warnings.join("\n"));
  assertStringIncludes(warnings[0], a);
  assertStringIncludes(warnings[0], b);
  assert(!warnings[0].includes(outside), warnings[0]);
  assertStringIncludes(warnings[0], FAKE_ADVICE);
  // Each listing asks once, even when it has nothing new to say.
  assertEquals(stats.listings, 2);
});

Deno.test("warnUnreadableLeftOut: names only the records `include` keeps, and stays silent when none are left", async () => {
  const dir = scratchDir();
  const kept = join(dir, "def-1-x.yaml");
  const skipped = join(dir, "def-2-x.yaml");
  const { lookup } = fakeUnreadableLookup([kept, skipped]);
  const warnings = await captureUnreadableWarnings(async () => {
    await warnUnreadableLeftOut(
      lookup,
      dir,
      (entry) => entry.path.endsWith("def-1-x.yaml"),
    );
    await warnUnreadableLeftOut(lookup, join(dir, "empty"));
  });
  assertEquals(warnings.length, 1, warnings.join("\n"));
  assertStringIncludes(warnings[0], kept);
  assert(!warnings[0].includes(skipped), warnings[0]);
});

Deno.test("warnUnreadableLeftOut: a failing listing warns that the answer may leave records out instead of failing it", async () => {
  const dir = scratchDir();
  const lookup = Object.assign(() => Promise.resolve(undefined), {
    under: () => Promise.reject(new Error("disk I/O error")),
  });
  const warnings = await captureUnreadableWarnings(() =>
    warnUnreadableLeftOut(lookup, dir)
  );
  assertEquals(warnings.length, 1);
  assertStringIncludes(warnings[0], dir);
  assertStringIncludes(warnings[0], "disk I/O error");
});

Deno.test("unreadableRecordsUnder: empty without a lookup, or with one that cannot list", async () => {
  const dir = scratchDir();
  assertEquals(await unreadableRecordsUnder(undefined, dir), []);
  assertEquals(
    await unreadableRecordsUnder(() => Promise.resolve(undefined), dir),
    [],
  );
  const path = join(dir, "x.yaml");
  const { lookup } = fakeUnreadableLookup([path]);
  assertEquals(
    (await unreadableRecordsUnder(lookup, dir)).map((e) => e.path),
    [path],
  );
});

Deno.test("mayBeUnreadableError: says the subject was not found and names each record, with the not_found code (not the unreadable-content code) and their paths", () => {
  const dir = scratchDir();
  const paths = [join(dir, "a.yaml"), join(dir, "b.yaml")];
  const { errors } = fakeUnreadableLookup(paths);
  const error = mayBeUnreadableError(
    "The output 123",
    paths.map((path) => ({
      path,
      error: errors.get(path)!,
      advice: FAKE_ADVICE,
    })),
  );
  // The subject may be a mistyped id none of them holds.
  assertEquals(error.code, "not_found");
  assertStringIncludes(error.message, "The output 123 was not found");
  assertStringIncludes(error.message, "may be one of these records");
  for (const path of paths) assertStringIncludes(error.message, path);
  assertStringIncludes(error.message, FAKE_ADVICE);
  assertEquals(errorPaths(error), paths);
});
