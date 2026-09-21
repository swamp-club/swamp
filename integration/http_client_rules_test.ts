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
 * Fitness test for HTTP client construction:
 *
 *   No `Deno.HttpClient` is created at module scope.
 *
 * `Deno.createHttpClient()` reads the platform certificate store. On a macOS
 * machine where that read fails, a module-scope client took the whole CLI
 * down with an uncaught `SecTrustSettingsCopyCertificates` error before any
 * command ran — including offline ones like `swamp help` and
 * `swamp model search` (swamp-club#2293). Clients must be created lazily, so
 * the failure reaches only the commands that actually open a connection.
 *
 * Static — no subprocesses, nothing is executed.
 */

import { assertEquals } from "@std/assert";
import {
  productionSourceFiles,
  repoRelative,
  SRC_DIR,
} from "./arch_fitness_helpers.ts";

/** A client bound at module scope: `const`/`let` in column 0. */
const MODULE_SCOPE_CLIENT =
  /^(?:export\s+)?(?:const|let|var)\s+\w+[^\n=]*=\s*(?:Deno\.createHttpClient|createTlsHttpClient)\(/m;

Deno.test("no Deno.HttpClient is created at module scope", async () => {
  const offenders: string[] = [];
  for await (const path of productionSourceFiles(SRC_DIR)) {
    const source = await Deno.readTextFile(path);
    if (MODULE_SCOPE_CLIENT.test(source)) offenders.push(repoRelative(path));
  }
  assertEquals(
    offenders.sort(),
    [],
    "create HTTP clients lazily inside a function — a module-scope client " +
      "crashes every command when the platform certificate store is " +
      "unreadable (swamp-club#2293)",
  );
});
