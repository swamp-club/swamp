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
 * The v3 read model names the Linux boot under the permissions the released
 * binary is compiled with (swamp-club#3418). Deno refuses any read under
 * `/proc` without `--allow-all`, which `scripts/compile.ts` does not grant;
 * with no boot named, a Linux checkout synced every file it caught up.
 * The grant is read from the compile script, so a change to it is tested
 * here too.
 */

import { assert, assertEquals } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import { readBootIdentity } from "../src/infrastructure/datastore_v3/boot_identity.ts";

const COMPILE_SCRIPT = join(
  fromFileUrl(new URL("..", import.meta.url)),
  "scripts",
  "compile.ts",
);

/** The `--allow-*` flags `scripts/compile.ts` compiles the binary with. */
function compiledGrant(): Deno.PermissionOptionsObject {
  const source = Deno.readTextFileSync(COMPILE_SCRIPT);
  const names = [...source.matchAll(/"--allow-([a-z]+)"/g)].map((m) => m[1]);
  assert(
    !names.includes("all"),
    "the binary is compiled with --allow-all; this test pins a grant without it",
  );
  const grant: Record<string, boolean> = {};
  for (const name of names) grant[name] = true;
  return grant as Deno.PermissionOptionsObject;
}

const GRANT = compiledGrant();

Deno.test("compiledGrant: reads the binary's grant from the compile script", () => {
  // The read model needs read, and run for `cat` past `/proc`.
  assertEquals(GRANT.read, true);
  assertEquals(GRANT.run, true);
});

Deno.test({
  name:
    "readBootIdentity: names the Linux boot under the released binary's grant (swamp-club#3418)",
  ignore: Deno.build.os !== "linux",
  permissions: GRANT,
  async fn() {
    const id = await readBootIdentity("linux");
    assert(
      id !== undefined && /^boot-id:[0-9a-f-]{36}$/.test(id),
      `expected a boot id, got ${id}`,
    );
  },
});
