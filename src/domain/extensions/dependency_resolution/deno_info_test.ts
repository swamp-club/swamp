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
import { withMockedCommand } from "@swamp-club/swamp-testing";
import { runDenoInfo } from "./deno_info.ts";

const ROOT = "file:///ext/m.ts";

Deno.test("runDenoInfo: runs deno info --json with the caller's flags, cwd and env, the root last", async () => {
  const { calls } = await withMockedCommand(
    [{ stdout: JSON.stringify({ modules: [] }), code: 0 }],
    () =>
      runDenoInfo("deno", ROOT, "/ext/m.ts", {
        args: ["--config", "/ext/deno.json", "--frozen"],
        cwd: "/ext",
        env: { DENO_DIR: "/cache" },
      }),
  );
  assertEquals(calls.length, 1);
  assertEquals(calls[0].command, "deno");
  assertEquals(calls[0].args, [
    "info",
    "--json",
    "--config",
    "/ext/deno.json",
    "--frozen",
    ROOT,
  ]);
  assertEquals(calls[0].cwd, "/ext");
  assertEquals(calls[0].env, { DENO_DIR: "/cache" });
});

Deno.test("runDenoInfo: keeps the exact versions Deno reports in redirects and npmPackages", async () => {
  const json = {
    roots: [ROOT],
    modules: [],
    redirects: {
      "jsr:@std/assert@^1": "https://jsr.io/@std/assert/1.0.19/mod.ts",
      "bad": 1,
    },
    npmPackages: { "ms@2.1.3": { name: "ms", version: "2.1.3" } },
  };
  const { result } = await withMockedCommand(
    [{ stdout: JSON.stringify(json), code: 0 }],
    () => runDenoInfo("deno", ROOT, "/ext/m.ts", { args: [] }),
  );
  assertEquals(result, {
    success: true,
    graph: {
      json,
      redirects: {
        "jsr:@std/assert@^1": "https://jsr.io/@std/assert/1.0.19/mod.ts",
      },
      npmPackages: { "ms@2.1.3": { name: "ms", version: "2.1.3" } },
    },
  });
});

Deno.test("runDenoInfo: a failed run answers with its exit code and stderr", async () => {
  const { result } = await withMockedCommand(
    [{ stdout: "", stderr: "error: Module not found", code: 1 }],
    () => runDenoInfo("deno", ROOT, "/ext/m.ts", { args: [] }),
  );
  assertEquals(result, {
    success: false,
    code: 1,
    stderr: "error: Module not found",
  });
});

Deno.test("runDenoInfo: output that is not JSON throws, naming the module", async () => {
  await withMockedCommand(
    [{ stdout: "not json", code: 0 }],
    () =>
      assertRejects(
        () => runDenoInfo("deno", ROOT, "/ext/m.ts", { args: [] }),
        Error,
        "deno info returned invalid JSON for /ext/m.ts",
      ),
  );
});
