#!/usr/bin/env -S deno run -A

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

import { assertEquals, assertNotEquals, assertThrows } from "@std/assert";
import { dirname, fromFileUrl, join } from "@std/path";
import { stampBuildInfo, VERSION_FILE } from "./compile.ts";

const buildInfoPath = join(
  dirname(fromFileUrl(import.meta.url)),
  "..",
  VERSION_FILE,
);

const VERSION_LINE = /^export const VERSION = .*$/m;
const GIT_SHA_LINE = /^export const GIT_SHA = .*$/m;

Deno.test("stampBuildInfo: stamps both constants in the real build info file", async () => {
  const source = await Deno.readTextFile(buildInfoPath);

  const stamped = stampBuildInfo(source, {
    version: "20990101.000000.0-sha.abc1234",
    sha: "abc1234",
  });

  assertEquals(
    stamped.match(VERSION_LINE)?.[0],
    'export const VERSION = "20990101.000000.0-sha.abc1234";',
  );
  assertEquals(
    stamped.match(GIT_SHA_LINE)?.[0],
    'export const GIT_SHA = "abc1234";',
  );
});

Deno.test("stampBuildInfo: leaves a constant whose value is not given untouched", async () => {
  const source = await Deno.readTextFile(buildInfoPath);

  const shaOnly = stampBuildInfo(source, { sha: "abc1234" });
  assertEquals(shaOnly.match(VERSION_LINE)?.[0], source.match(VERSION_LINE)?.[0]);
  assertNotEquals(shaOnly, source);

  assertEquals(stampBuildInfo(source, {}), source);
});

Deno.test("stampBuildInfo: throws when a requested constant is missing", () => {
  const noVersion = 'export const GIT_SHA = "";\n';
  const noSha = 'export const VERSION = "1.0.0";\n';

  assertThrows(
    () => stampBuildInfo(noVersion, { version: "2.0.0" }),
    Error,
    "no VERSION constant",
  );
  assertThrows(
    () => stampBuildInfo(noSha, { sha: "abc1234" }),
    Error,
    "no GIT_SHA constant",
  );
});
