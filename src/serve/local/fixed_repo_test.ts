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

import { assertEquals, assertRejects } from "@std/assert";
import { UserError } from "../../domain/errors.ts";
import { type FixedRepoDeps, resolveFixedRepo } from "./fixed_repo.ts";

function deps(over: Partial<FixedRepoDeps> = {}): FixedRepoDeps {
  return {
    realPath: (p) => Promise.resolve(p.replace(/^\/tmp\//, "/private/tmp/")),
    isRepo: () => Promise.resolve(true),
    registered: () => Promise.resolve([]),
    ...over,
  };
}

Deno.test("resolveFixedRepo: an unregistered repo is served under its folder name", async () => {
  assertEquals(await resolveFixedRepo(deps(), "/tmp/work/my-repo"), {
    name: "my-repo",
    path: "/private/tmp/work/my-repo",
  });
});

Deno.test("resolveFixedRepo: a registered folder keeps its workspace name, matched on the real path", async () => {
  const found = await resolveFixedRepo(
    deps({
      registered: () =>
        Promise.resolve([
          { name: "other", path: "/private/tmp/elsewhere" },
          { name: "misty-heron", path: "/tmp/work/my-repo" },
        ]),
    }),
    "/private/tmp/work/my-repo",
  );
  assertEquals(found, {
    name: "misty-heron",
    path: "/private/tmp/work/my-repo",
  });
});

Deno.test("resolveFixedRepo: a registered folder that is gone matches nothing", async () => {
  const found = await resolveFixedRepo(
    deps({
      realPath: (p) =>
        p === "/gone"
          ? Promise.reject(new Error("missing"))
          : Promise.resolve(p),
      registered: () => Promise.resolve([{ name: "ghost", path: "/gone" }]),
    }),
    "/work/repo",
  );
  assertEquals(found.name, "repo");
});

Deno.test("resolveFixedRepo: a folder that is not a swamp repo is refused with not_a_repo", async () => {
  const error = await assertRejects(
    () =>
      resolveFixedRepo(
        deps({ isRepo: () => Promise.resolve(false) }),
        "/work/x",
      ),
    UserError,
  );
  assertEquals((error as UserError).code, "not_a_repo");
});

Deno.test("resolveFixedRepo: a repo at the filesystem root still gets a name", async () => {
  assertEquals((await resolveFixedRepo(deps(), "/")).name, "root");
});
