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

import { assert } from "@std/assert";
import {
  assertPinnedSet,
  productionSourceFiles,
  repoRelative,
  SRC_DIR,
} from "./arch_fitness_helpers.ts";

const COOKIE_MODULE = "src/serve/dashboard_session_cookie.ts";
const PLAIN_NAME =
  /["'`]swamp-dashboard-session["'`]|PLAIN_DASHBOARD_SESSION_COOKIE/;

Deno.test("dashboard session cookie: only its own module names the plain cookie", async () => {
  const naming: string[] = [];
  let sawModule = false;
  for await (const path of productionSourceFiles(SRC_DIR)) {
    const file = repoRelative(path);
    if (file === COOKIE_MODULE) {
      sawModule = true;
      continue;
    }
    if (PLAIN_NAME.test(await Deno.readTextFile(path))) naming.push(file);
  }
  assert(sawModule, `${COOKIE_MODULE} exists`);
  assertPinnedSet(
    naming,
    [],
    "production modules that name the plain dashboard session cookie",
    "A workspace a host runs reads and writes a cookie named for its address\n" +
      "path. Take the cookie from DashboardSessionCookie.forServe so every\n" +
      "reader and writer agrees on it.",
  );
});
