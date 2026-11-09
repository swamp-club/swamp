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
import {
  productionSourceFiles,
  repoRelative,
  SRC_DIR,
} from "./arch_fitness_helpers.ts";
import { isDataPlaneRequest } from "../src/serve/data_plane.ts";
import {
  isReservedServePath,
  WEBHOOK_ROUTE_PREFIX,
} from "../src/serve/webhook_route.ts";

const SERVE_DIR = join(SRC_DIR, "serve");
const SERVE_COMMAND = join(SRC_DIR, "cli", "commands", "serve.ts");

// start/ and local/ run their own listeners; webhook_route.ts defines the rule.
const EXCLUDED = ["src/serve/start/", "src/serve/local/"];
const RULE_FILE = "src/serve/webhook_route.ts";

const PATH_LITERAL = /(?:[!=]==\s*|startsWith\(\s*)"(\/[^"]*)"/g;
const ROUTE_CONSTANT =
  /const\s+([A-Z][A-Z0-9_]*(?:PATH|PREFIX|ROUTE))\s*(?::\s*\w+\s*)?=\s*"(\/[^"]*)"/g;

// Floors at the current counts, so a scan that stops matching fails loudly.
const MIN_PATH_LITERALS = 25;
const MIN_ROUTE_CONSTANTS = 5;

interface ServePath {
  readonly path: string;
  readonly where: string;
}

async function servePaths(): Promise<{
  literals: ServePath[];
  constants: ServePath[];
}> {
  const files = [SERVE_COMMAND];
  for await (const file of productionSourceFiles(SERVE_DIR)) {
    const rel = repoRelative(file);
    if (rel === RULE_FILE || EXCLUDED.some((dir) => rel.startsWith(dir))) {
      continue;
    }
    files.push(file);
  }
  const literals: ServePath[] = [];
  const constants: ServePath[] = [];
  for (const file of files) {
    const source = await Deno.readTextFile(file);
    const where = repoRelative(file);
    for (const m of source.matchAll(PATH_LITERAL)) {
      literals.push({ path: m[1], where });
    }
    for (const m of source.matchAll(ROUTE_CONSTANT)) {
      constants.push({ path: m[2], where: `${where} ${m[1]}` });
    }
  }
  return { literals, constants };
}

Deno.test("serve webhook route rules: every path serve answers is under a reserved root and outside the webhook prefix", async () => {
  const { literals, constants } = await servePaths();

  assert(
    literals.length >= MIN_PATH_LITERALS,
    `found ${literals.length} path comparisons in serve sources, expected ` +
      `at least ${MIN_PATH_LITERALS}; the scan sees ===, !== and startsWith ` +
      `against a string literal only`,
  );
  assert(
    constants.length >= MIN_ROUTE_CONSTANTS,
    `found ${constants.length} route constants in src/serve, expected at ` +
      `least ${MIN_ROUTE_CONSTANTS}; the scan sees const *PATH, *PREFIX and ` +
      `*ROUTE string literals only`,
  );

  for (const { path, where } of [...literals, ...constants]) {
    assert(
      isReservedServePath(path),
      `${where} answers ${path}, which is outside serve's reserved roots, so ` +
        `an operator webhook route could shadow it; move it under /api/ or ` +
        `add its root to SERVE_RESERVED_ROOTS in ${RULE_FILE}`,
    );
    assert(
      !path.startsWith(WEBHOOK_ROUTE_PREFIX),
      `${where} answers ${path}, but ${WEBHOOK_ROUTE_PREFIX} is reserved for ` +
        `webhook routes`,
    );
  }
});

Deno.test("serve webhook route rules: every data plane path is reserved", () => {
  for (const path of ["/data", "/data/x", "/bundle/x", "//data/x"]) {
    assertEquals(
      isDataPlaneRequest(new Request(`http://localhost${path}`)),
      true,
      path,
    );
    assert(isReservedServePath(path), path);
  }
  assertEquals(
    isDataPlaneRequest(new Request(`http://localhost${WEBHOOK_ROUTE_PREFIX}x`)),
    false,
  );
});
