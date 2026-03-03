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

import { assertStringIncludes } from "@std/assert";
import type {
  SourceCleanResult,
  SourceFetchResult,
  SourceInfoResult,
} from "../../domain/source/mod.ts";
import {
  renderSourceClean,
  renderSourceFetch,
  renderSourcePath,
} from "./source_output.ts";

// Helper to capture console.log output
function captureOutput(fn: () => void): string {
  const originalLog = console.log;
  let output = "";
  console.log = (...args: unknown[]) => {
    output += args.map((a) => String(a)).join(" ") + "\n";
  };
  try {
    fn();
  } finally {
    console.log = originalLog;
  }
  return output;
}

Deno.test("renderSourceFetch with json mode outputs valid JSON for fetched status", () => {
  const result: SourceFetchResult = {
    status: "fetched",
    version: "v1.0.0",
    path: "/home/user/.swamp/source",
    fileCount: 245,
    fetchedAt: "2026-01-01T00:00:00.000Z",
  };

  const output = captureOutput(() => renderSourceFetch(result, "json"));
  const parsed = JSON.parse(output);

  assertStringIncludes(parsed.status, "fetched");
  assertStringIncludes(parsed.version, "v1.0.0");
});

Deno.test("renderSourceFetch with json mode includes previousVersion when present", () => {
  const result: SourceFetchResult = {
    status: "fetched",
    version: "v2.0.0",
    path: "/home/user/.swamp/source",
    fileCount: 245,
    fetchedAt: "2026-01-01T00:00:00.000Z",
    previousVersion: "v1.0.0",
  };

  const output = captureOutput(() => renderSourceFetch(result, "json"));
  const parsed = JSON.parse(output);

  assertStringIncludes(parsed.previousVersion, "v1.0.0");
});

Deno.test("renderSourceFetch with log mode does not throw", () => {
  const result: SourceFetchResult = {
    status: "fetched",
    version: "v1.0.0",
    path: "/home/user/.swamp/source",
    fileCount: 245,
    fetchedAt: "2026-01-01T00:00:00.000Z",
  };

  // Should not throw
  renderSourceFetch(result, "log");
});

Deno.test("renderSourcePath with json mode outputs valid JSON for found status", () => {
  const result: SourceInfoResult = {
    status: "found",
    version: "v1.0.0",
    path: "/home/user/.swamp/source",
    fileCount: 245,
    fetchedAt: "2026-01-01T00:00:00.000Z",
  };

  const output = captureOutput(() => renderSourcePath(result, "json"));
  const parsed = JSON.parse(output);

  assertStringIncludes(parsed.status, "found");
  assertStringIncludes(parsed.version, "v1.0.0");
});

Deno.test("renderSourcePath with json mode outputs valid JSON for not_found status", () => {
  const result: SourceInfoResult = {
    status: "not_found",
  };

  const output = captureOutput(() => renderSourcePath(result, "json"));
  const parsed = JSON.parse(output);

  assertStringIncludes(parsed.status, "not_found");
});

Deno.test("renderSourcePath with log mode does not throw", () => {
  const result: SourceInfoResult = {
    status: "found",
    version: "v1.0.0",
    path: "/home/user/.swamp/source",
    fileCount: 245,
    fetchedAt: "2026-01-01T00:00:00.000Z",
  };

  // Should not throw
  renderSourcePath(result, "log");
});

Deno.test("renderSourceClean with json mode outputs valid JSON for cleaned status", () => {
  const result: SourceCleanResult = {
    status: "cleaned",
    path: "/home/user/.swamp/source",
  };

  const output = captureOutput(() => renderSourceClean(result, "json"));
  const parsed = JSON.parse(output);

  assertStringIncludes(parsed.status, "cleaned");
  assertStringIncludes(parsed.path, ".swamp/source");
});

Deno.test("renderSourceClean with json mode outputs valid JSON for not_found status", () => {
  const result: SourceCleanResult = {
    status: "not_found",
    path: "/home/user/.swamp/source",
  };

  const output = captureOutput(() => renderSourceClean(result, "json"));
  const parsed = JSON.parse(output);

  assertStringIncludes(parsed.status, "not_found");
});

Deno.test("renderSourceClean with log mode does not throw", () => {
  const result: SourceCleanResult = {
    status: "cleaned",
    path: "/home/user/.swamp/source",
  };

  // Should not throw
  renderSourceClean(result, "log");
});
