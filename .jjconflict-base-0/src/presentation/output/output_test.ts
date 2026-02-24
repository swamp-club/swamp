// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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
import { renderVersion, type VersionData } from "./output.ts";

const testData: VersionData = {
  version: "1.0.0",
};

Deno.test("renderVersion with json mode outputs valid JSON", () => {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);

  try {
    renderVersion(testData, "json");
    assertEquals(logs.length, 1);

    const parsed = JSON.parse(logs[0]);
    assertEquals(parsed.version, "1.0.0");
  } finally {
    console.log = originalLog;
  }
});

Deno.test("renderVersion with json mode includes version field", () => {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);

  try {
    renderVersion(testData, "json");
    assertStringIncludes(logs[0], '"version"');
    assertStringIncludes(logs[0], '"1.0.0"');
  } finally {
    console.log = originalLog;
  }
});
