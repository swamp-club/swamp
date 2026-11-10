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

import { assert, assertEquals, assertGreater } from "@std/assert";
import { walk } from "@std/fs/walk";
import { join, relative } from "@std/path";
import { callArguments, toPosixPath } from "./arch_fitness_helpers.ts";
import * as rateLimiter from "../src/serve/rate_limiter.ts";

const ROOT = join(import.meta.dirname!, "..");
const LIMITER = "src/serve/rate_limiter.ts";
const COUNTING_CALL = /\b(limitFailedAttempts|recordFailedAttempt)\(/g;
const KEY_CALL = "failedAttemptKey(";

/** a bare identifier counts as its const initializer in the same file */
function built(key: string, source: string): string {
  if (!/^\w+$/.test(key)) return key;
  const declared = source.match(new RegExp(`\\bconst ${key}\\s*=\\s*([^;]+);`));
  return declared === null ? key : declared[1].trim();
}

async function countingCalls(): Promise<{ site: string; key: string }[]> {
  const calls: { site: string; key: string }[] = [];
  for await (
    const entry of walk(join(ROOT, "src"), {
      exts: [".ts", ".tsx"],
      skip: [/_test\.tsx?$/],
    })
  ) {
    const rel = toPosixPath(relative(ROOT, entry.path));
    if (rel === LIMITER) continue;
    const source = await Deno.readTextFile(entry.path);
    for (const match of source.matchAll(COUNTING_CALL)) {
      const open = match.index! + match[0].length;
      const line = source.slice(0, match.index).split("\n").length;
      const [key = ""] = callArguments(source, open);
      calls.push({
        site: `${rel}:${line} ${match[1]}`,
        key: built(key, source),
      });
    }
  }
  return calls;
}

Deno.test("serve failed-attempt keys: every counting call builds its key with failedAttemptKey", async () => {
  const calls = await countingCalls();
  assertGreater(calls.length, 0, "no counting calls found; the rule is blind");
  const bare = calls
    .filter((call) => !call.key.startsWith(KEY_CALL))
    .map((call) => `${call.site}: ${call.key}`);
  assertEquals(
    bare,
    [],
    "A failed-attempt key built any other way can leave out the address or " +
      "count a whole credential kind as one principal. Pass " +
      "failedAttemptKey(credential, address, scope?) from " +
      `${LIMITER}.\n\nViolations:\n${bare.join("\n")}`,
  );
});

Deno.test("serve failed-attempt keys: the limiter exports no other key builder", () => {
  const builders = Object.keys(rateLimiter)
    .filter((name) => /key/i.test(name))
    .sort();
  assertEquals(builders, ["failedAttemptKey"]);
});

Deno.test("serve failed-attempt keys: every key names the address and never a shared prefix alone", () => {
  const address = "203.0.113.9";
  for (
    const credential of [
      null,
      "",
      "name.secret",
      `swda1.${crypto.randomUUID()}.${"a".repeat(64)}`,
      `swdr1.${crypto.randomUUID()}.${"a".repeat(64)}`,
      `swdx1.${crypto.randomUUID()}.${"a".repeat(64)}`,
      `swi1.slackwater.${"a".repeat(64)}`,
      "swda1.junk.junk",
      "swi1.junk",
      "swamp-peer.junk",
    ]
  ) {
    const key = rateLimiter.failedAttemptKey(credential, address);
    assert(
      key.endsWith(`|address:${address}`) || key === `address:${address}`,
      key,
    );
    for (const shared of ["swda1", "swdr1", "swdx1", "swi1"]) {
      assert(!key.includes(`token:${shared}|`), key);
    }
  }
});
