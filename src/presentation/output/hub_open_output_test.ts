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

import { assertEquals, assertStringIncludes } from "@std/assert";
import { stripAnsiCode } from "@std/fmt/colors";
import { renderHubOpened } from "./hub_open_output.ts";

function captureLogs(run: () => void): string {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);
  try {
    run();
  } finally {
    console.log = originalLog;
  }
  return logs.join("\n");
}

const data = {
  url: "http://127.0.0.1:4100/dashboard/hub#token=abc",
  port: 4100,
  pid: 77,
};

Deno.test("renderHubOpened: json mode reports the page, the hub and whether it opened", () => {
  const output = captureLogs(() => renderHubOpened("json", data, false));
  assertEquals(JSON.parse(output), { ...data, opened: false });
});

Deno.test("renderHubOpened: log mode prints the page address either way", () => {
  const opened = stripAnsiCode(
    captureLogs(() => renderHubOpened("log", data, true)),
  );
  assertStringIncludes(opened, "Opened your swamp hub overview:");
  assertStringIncludes(opened, data.url);
  assertStringIncludes(opened, "Hub pid 77 on port 4100");
  assertStringIncludes(opened, "keeps its access while it is open");
  const printed = stripAnsiCode(
    captureLogs(() => renderHubOpened("log", data, false)),
  );
  assertStringIncludes(
    printed,
    "Open your swamp hub overview in your browser:",
  );
  assertStringIncludes(printed, data.url);
});
