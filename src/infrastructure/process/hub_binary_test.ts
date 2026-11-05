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
import { type HubBinaryDeps, locateHubBinaries } from "./hub_binary.ts";

function deps(
  overrides: Partial<HubBinaryDeps> & { files?: string[] } = {},
): HubBinaryDeps {
  const files = new Set(overrides.files ?? []);
  return {
    env: () => undefined,
    execPath: () => "/opt/swamp/bin/swamp",
    isFile: (path) => Promise.resolve(files.has(path)),
    os: "linux",
    ...overrides,
  };
}

Deno.test("locateHubBinaries: finds swamp-serve next to the swamp executable", async () => {
  assertEquals(
    await locateHubBinaries(
      deps({ files: ["/opt/swamp/bin/swamp", "/opt/swamp/bin/swamp-serve"] }),
    ),
    { hub: "/opt/swamp/bin/swamp-serve", engine: "/opt/swamp/bin/swamp" },
  );
});

Deno.test("locateHubBinaries: none when this install has no hub", async () => {
  assertEquals(
    await locateHubBinaries(deps({ files: ["/opt/swamp/bin/swamp"] })),
    null,
  );
});

Deno.test("locateHubBinaries: from source there is no engine unless one is named", async () => {
  const fromSource = deps({
    execPath: () => "/home/me/.deno/bin/deno",
    files: [
      "/home/me/.deno/bin/swamp-serve",
      "/build/swamp",
      "/build/swamp-serve",
    ],
  });
  assertEquals(await locateHubBinaries(fromSource), null);
  assertEquals(
    await locateHubBinaries({
      ...fromSource,
      env: (name) => name === "SWAMP_HUB_ENGINE" ? "/build/swamp" : undefined,
    }),
    { hub: "/build/swamp-serve", engine: "/build/swamp" },
  );
});

Deno.test("locateHubBinaries: SWAMP_SERVE_BINARY names the hub, and only an absolute path counts", async () => {
  const files = ["/opt/swamp/bin/swamp", "/elsewhere/swamp-serve"];
  const named = (value: string) =>
    deps({
      files,
      env: (name) => name === "SWAMP_SERVE_BINARY" ? value : undefined,
    });
  assertEquals(await locateHubBinaries(named("/elsewhere/swamp-serve")), {
    hub: "/elsewhere/swamp-serve",
    engine: "/opt/swamp/bin/swamp",
  });
  assertEquals(await locateHubBinaries(named("swamp-serve")), null);
});

Deno.test("locateHubBinaries: Windows looks for swamp-serve.exe", async () => {
  assertEquals(
    await locateHubBinaries(deps({
      os: "windows",
      execPath: () => "C:\\swamp\\swamp.exe",
      files: ["C:\\swamp\\swamp.exe", "C:\\swamp\\swamp-serve.exe"],
    })),
    Deno.build.os === "windows"
      ? { hub: "C:\\swamp\\swamp-serve.exe", engine: "C:\\swamp\\swamp.exe" }
      : null,
  );
});
