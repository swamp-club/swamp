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

import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  isCommentLine,
  productionSourceFiles,
  repoRelative,
  ROOT,
} from "./arch_fitness_helpers.ts";

// the process port is the one place in the serve host that touches a process,
// so the supervisor stays testable with a fake port
const HOST_DIR = join(ROOT, "src", "serve", "host");
const PROCESS_ADAPTER = "src/serve/host/deno_serve_process.ts";
const PROCESS_API = /\bDeno\.(?:Command|ChildProcess|kill)\b/;

Deno.test("serve host: only the process port adapter starts or signals a process", async () => {
  const offenders: string[] = [];
  for await (const path of productionSourceFiles(HOST_DIR)) {
    const rel = repoRelative(path);
    if (rel === PROCESS_ADAPTER) continue;
    const source = await Deno.readTextFile(path);
    source.split("\n").forEach((line, index) => {
      if (!isCommentLine(line) && PROCESS_API.test(line)) {
        offenders.push(`${rel}:${index + 1}`);
      }
    });
  }
  assertEquals(offenders, []);
});

Deno.test("serve host: the process port adapter is where the rule expects it", async () => {
  const source = await Deno.readTextFile(join(ROOT, PROCESS_ADAPTER));
  assertEquals(PROCESS_API.test(source), true);
});
