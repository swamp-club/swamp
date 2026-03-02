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

import { assertEquals } from "@std/assert/equals";
import {
  renderExtensionNotInstalled,
  renderExtensionUpdateCheck,
  renderExtensionUpdateProgress,
  renderExtensionUpdateResult,
  renderNoExtensionsInstalled,
} from "./extension_update_output.ts";
import type { ExtensionUpdateResult } from "../../domain/extensions/extension_update_service.ts";

function captureConsoleLog(fn: () => void): string {
  const original = console.log;
  let captured = "";
  console.log = (msg: string) => {
    captured += msg;
  };
  try {
    fn();
  } finally {
    console.log = original;
  }
  return captured;
}

// --- renderExtensionUpdateCheck ---

Deno.test("renderExtensionUpdateCheck outputs valid JSON with up_to_date status", () => {
  const result: ExtensionUpdateResult = {
    extensions: [
      {
        status: "up_to_date",
        name: "@test/ext",
        installedVersion: "2026.01.01.1",
        latestVersion: "2026.01.01.1",
      },
    ],
    summary: { total: 1, upToDate: 1, updated: 0, failed: 0 },
  };
  const output = captureConsoleLog(() => {
    renderExtensionUpdateCheck(result, "json");
  });
  const parsed = JSON.parse(output);
  assertEquals(parsed.extensions.length, 1);
  assertEquals(parsed.extensions[0].status, "up_to_date");
  assertEquals(parsed.summary.upToDate, 1);
});

Deno.test("renderExtensionUpdateCheck outputs valid JSON with update_available status", () => {
  const result: ExtensionUpdateResult = {
    extensions: [
      {
        status: "update_available",
        name: "@test/ext",
        installedVersion: "2026.01.01.1",
        latestVersion: "2026.02.01.1",
      },
    ],
    summary: { total: 1, upToDate: 0, updated: 0, failed: 0 },
  };
  const output = captureConsoleLog(() => {
    renderExtensionUpdateCheck(result, "json");
  });
  const parsed = JSON.parse(output);
  assertEquals(parsed.extensions[0].status, "update_available");
  assertEquals(parsed.extensions[0].latestVersion, "2026.02.01.1");
});

Deno.test("renderExtensionUpdateCheck outputs valid JSON with not_found status", () => {
  const result: ExtensionUpdateResult = {
    extensions: [
      {
        status: "not_found",
        name: "@test/ext",
        installedVersion: "2026.01.01.1",
        error: "Not found in registry",
      },
    ],
    summary: { total: 1, upToDate: 0, updated: 0, failed: 1 },
  };
  const output = captureConsoleLog(() => {
    renderExtensionUpdateCheck(result, "json");
  });
  const parsed = JSON.parse(output);
  assertEquals(parsed.extensions[0].status, "not_found");
  assertEquals(parsed.summary.failed, 1);
});

Deno.test("renderExtensionUpdateCheck handles empty extensions in json mode", () => {
  const result: ExtensionUpdateResult = {
    extensions: [],
    summary: { total: 0, upToDate: 0, updated: 0, failed: 0 },
  };
  const output = captureConsoleLog(() => {
    renderExtensionUpdateCheck(result, "json");
  });
  const parsed = JSON.parse(output);
  assertEquals(parsed.extensions, []);
});

Deno.test("renderExtensionUpdateCheck in log mode does not throw for up_to_date", () => {
  const result: ExtensionUpdateResult = {
    extensions: [
      {
        status: "up_to_date",
        name: "@test/ext",
        installedVersion: "2026.01.01.1",
        latestVersion: "2026.01.01.1",
      },
    ],
    summary: { total: 1, upToDate: 1, updated: 0, failed: 0 },
  };
  renderExtensionUpdateCheck(result, "log");
});

Deno.test("renderExtensionUpdateCheck in log mode does not throw for update_available", () => {
  const result: ExtensionUpdateResult = {
    extensions: [
      {
        status: "update_available",
        name: "@test/ext",
        installedVersion: "2026.01.01.1",
        latestVersion: "2026.02.01.1",
      },
    ],
    summary: { total: 1, upToDate: 0, updated: 0, failed: 0 },
  };
  renderExtensionUpdateCheck(result, "log");
});

Deno.test("renderExtensionUpdateCheck in log mode does not throw for not_found", () => {
  const result: ExtensionUpdateResult = {
    extensions: [
      {
        status: "not_found",
        name: "@test/ext",
        installedVersion: "2026.01.01.1",
        error: "Not found",
      },
    ],
    summary: { total: 1, upToDate: 0, updated: 0, failed: 1 },
  };
  renderExtensionUpdateCheck(result, "log");
});

Deno.test("renderExtensionUpdateCheck in log mode handles empty list", () => {
  const result: ExtensionUpdateResult = {
    extensions: [],
    summary: { total: 0, upToDate: 0, updated: 0, failed: 0 },
  };
  renderExtensionUpdateCheck(result, "log");
});

// --- renderExtensionUpdateResult ---

Deno.test("renderExtensionUpdateResult outputs valid JSON with updated status", () => {
  const result: ExtensionUpdateResult = {
    extensions: [
      {
        status: "updated",
        name: "@test/ext",
        previousVersion: "2026.01.01.1",
        newVersion: "2026.02.01.1",
      },
    ],
    summary: { total: 1, upToDate: 0, updated: 1, failed: 0 },
  };
  const output = captureConsoleLog(() => {
    renderExtensionUpdateResult(result, "json");
  });
  const parsed = JSON.parse(output);
  assertEquals(parsed.extensions[0].status, "updated");
  assertEquals(parsed.extensions[0].newVersion, "2026.02.01.1");
  assertEquals(parsed.summary.updated, 1);
});

Deno.test("renderExtensionUpdateResult in log mode does not throw for mixed statuses", () => {
  const result: ExtensionUpdateResult = {
    extensions: [
      {
        status: "updated",
        name: "@test/a",
        previousVersion: "2026.01.01.1",
        newVersion: "2026.02.01.1",
      },
      {
        status: "up_to_date",
        name: "@test/b",
        installedVersion: "2026.02.01.1",
        latestVersion: "2026.02.01.1",
      },
      {
        status: "not_found",
        name: "@test/c",
        installedVersion: "2026.01.01.1",
        error: "Not found",
      },
    ],
    summary: { total: 3, upToDate: 1, updated: 1, failed: 1 },
  };
  renderExtensionUpdateResult(result, "log");
});

// --- renderExtensionUpdateProgress ---

Deno.test("renderExtensionUpdateProgress outputs valid JSON", () => {
  const output = captureConsoleLog(() => {
    renderExtensionUpdateProgress(
      "@test/ext",
      "2026.01.01.1",
      "2026.02.01.1",
      "json",
    );
  });
  const parsed = JSON.parse(output);
  assertEquals(parsed.status, "updating");
  assertEquals(parsed.name, "@test/ext");
  assertEquals(parsed.from, "2026.01.01.1");
  assertEquals(parsed.to, "2026.02.01.1");
});

Deno.test("renderExtensionUpdateProgress in log mode does not throw", () => {
  renderExtensionUpdateProgress(
    "@test/ext",
    "2026.01.01.1",
    "2026.02.01.1",
    "log",
  );
});

// --- renderNoExtensionsInstalled ---

Deno.test("renderNoExtensionsInstalled outputs valid JSON", () => {
  const output = captureConsoleLog(() => {
    renderNoExtensionsInstalled("json");
  });
  const parsed = JSON.parse(output);
  assertEquals(parsed.extensions, []);
  assertEquals(parsed.summary.total, 0);
});

Deno.test("renderNoExtensionsInstalled in log mode does not throw", () => {
  renderNoExtensionsInstalled("log");
});

// --- renderExtensionNotInstalled ---

// --- renderExtensionUpdateCheck with failed ---

Deno.test("renderExtensionUpdateCheck outputs valid JSON with failed status", () => {
  const result: ExtensionUpdateResult = {
    extensions: [
      {
        status: "failed",
        name: "@test/ext",
        installedVersion: "2026.01.01.1",
        error: "Update failed: integrity check failed",
      },
    ],
    summary: { total: 1, upToDate: 0, updated: 0, failed: 1 },
  };
  const output = captureConsoleLog(() => {
    renderExtensionUpdateCheck(result, "json");
  });
  const parsed = JSON.parse(output);
  assertEquals(parsed.extensions[0].status, "failed");
  assertEquals(parsed.summary.failed, 1);
});

Deno.test("renderExtensionUpdateCheck in log mode does not throw for failed", () => {
  const result: ExtensionUpdateResult = {
    extensions: [
      {
        status: "failed",
        name: "@test/ext",
        installedVersion: "2026.01.01.1",
        error: "Update failed: network error",
      },
    ],
    summary: { total: 1, upToDate: 0, updated: 0, failed: 1 },
  };
  renderExtensionUpdateCheck(result, "log");
});

// --- renderExtensionUpdateResult with failed ---

Deno.test("renderExtensionUpdateResult outputs valid JSON with failed status", () => {
  const result: ExtensionUpdateResult = {
    extensions: [
      {
        status: "failed",
        name: "@test/ext",
        installedVersion: "2026.01.01.1",
        error: "Update failed: safety error",
      },
    ],
    summary: { total: 1, upToDate: 0, updated: 0, failed: 1 },
  };
  const output = captureConsoleLog(() => {
    renderExtensionUpdateResult(result, "json");
  });
  const parsed = JSON.parse(output);
  assertEquals(parsed.extensions[0].status, "failed");
  assertEquals(parsed.extensions[0].error, "Update failed: safety error");
  assertEquals(parsed.summary.failed, 1);
});

Deno.test("renderExtensionUpdateResult in log mode does not throw for failed", () => {
  const result: ExtensionUpdateResult = {
    extensions: [
      {
        status: "failed",
        name: "@test/ext",
        installedVersion: "2026.01.01.1",
        error: "Update failed: integrity check failed",
      },
    ],
    summary: { total: 1, upToDate: 0, updated: 0, failed: 1 },
  };
  renderExtensionUpdateResult(result, "log");
});

Deno.test("renderExtensionUpdateResult in log mode handles mixed statuses with failed", () => {
  const result: ExtensionUpdateResult = {
    extensions: [
      {
        status: "updated",
        name: "@test/a",
        previousVersion: "2026.01.01.1",
        newVersion: "2026.02.01.1",
      },
      {
        status: "up_to_date",
        name: "@test/b",
        installedVersion: "2026.02.01.1",
        latestVersion: "2026.02.01.1",
      },
      {
        status: "not_found",
        name: "@test/c",
        installedVersion: "2026.01.01.1",
        error: "Not found",
      },
      {
        status: "failed",
        name: "@test/d",
        installedVersion: "2026.01.01.1",
        error: "Update failed: network error",
      },
    ],
    summary: { total: 4, upToDate: 1, updated: 1, failed: 2 },
  };
  renderExtensionUpdateResult(result, "log");
});

// --- renderExtensionNotInstalled ---

Deno.test("renderExtensionNotInstalled outputs valid JSON", () => {
  const output = captureConsoleLog(() => {
    renderExtensionNotInstalled("@test/ext", "json");
  });
  const parsed = JSON.parse(output);
  assertEquals(parsed.error, "Extension @test/ext is not installed.");
});

Deno.test("renderExtensionNotInstalled in log mode does not throw", () => {
  renderExtensionNotInstalled("@test/ext", "log");
});
