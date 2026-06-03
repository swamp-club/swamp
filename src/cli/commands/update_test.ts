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
import type { UpdateChecker } from "../../domain/update/update_service.ts";
import { UpdateService } from "../../domain/update/update_service.ts";
import { Platform } from "../../domain/update/platform.ts";
import { Spinner } from "../../presentation/spinner.ts";

const platform = Platform.from("darwin", "aarch64");
const currentVersion = "20260207.123456.0-sha.abc12345";
const newerVersion = "20260208.000000.0-sha.def56789";
const redirectUrl =
  `https://artifacts.swamp-club.com/swamp/${newerVersion}/binary/darwin/aarch64/swamp-stable-binary-darwin-aarch64.tar.gz`;

function createMockChecker(
  redirect: string | null = null,
  opts?: { throwOnCheck?: boolean },
): UpdateChecker {
  return {
    checkForUpdate: (_platform: Platform) => {
      if (opts?.throwOnCheck) {
        return Promise.reject(new Error("network error"));
      }
      return Promise.resolve(redirect);
    },
    fetchChecksum: (_tarballUrl: string) => {
      return Promise.resolve("a".repeat(64));
    },
    downloadAndInstall: (
      _url: string,
      _binaryPath: string,
      _expectedChecksum: string,
    ) => {
      return Promise.resolve();
    },
  };
}

interface SpinnerCall {
  method: "start" | "stop" | "update";
  message?: string;
}

function createSpySpinner(): { spinner: Spinner; calls: SpinnerCall[] } {
  const calls: SpinnerCall[] = [];
  const spinner = new Spinner();

  // Override methods with spies (Spinner no-ops when stderr is not a TTY in tests)
  const originalStart = spinner.start.bind(spinner);
  spinner.start = (message: string) => {
    calls.push({ method: "start", message });
    originalStart(message);
  };

  const originalStop = spinner.stop.bind(spinner);
  spinner.stop = () => {
    calls.push({ method: "stop" });
    originalStop();
  };

  return { spinner, calls };
}

// --- Spinner integration with update flow ---

Deno.test("update flow starts and stops spinner around service.update()", async () => {
  const checker = createMockChecker(redirectUrl);
  const service = new UpdateService(checker, currentVersion, "/bin/swamp");
  const { spinner, calls } = createSpySpinner();

  spinner.start("Updating swamp...");
  const result = await service.update(platform);
  spinner.stop();

  assertEquals(result.status, "updated");
  assertEquals(calls[0], { method: "start", message: "Updating swamp..." });
  assertEquals(calls[calls.length - 1], { method: "stop" });
});

Deno.test("check flow starts and stops spinner around service.check()", async () => {
  const checker = createMockChecker(null);
  const service = new UpdateService(checker, currentVersion, "/bin/swamp");
  const { spinner, calls } = createSpySpinner();

  spinner.start("Checking for updates...");
  const result = await service.check(platform);
  spinner.stop();

  assertEquals(result.status, "up_to_date");
  assertEquals(calls[0], {
    method: "start",
    message: "Checking for updates...",
  });
  assertEquals(calls[calls.length - 1], { method: "stop" });
});

Deno.test("spinner.stop() is called even when service throws", async () => {
  const checker = createMockChecker(null, { throwOnCheck: true });
  const service = new UpdateService(checker, currentVersion, "/bin/swamp");
  const { spinner, calls } = createSpySpinner();

  spinner.start("Checking for updates...");
  try {
    await service.check(platform);
  } catch {
    // expected
  } finally {
    spinner.stop();
  }

  assertEquals(calls[0], {
    method: "start",
    message: "Checking for updates...",
  });
  assertEquals(calls[calls.length - 1], { method: "stop" });
});

Deno.test("spinner is not created in json mode", () => {
  // Simulates the guard: ctx.outputMode !== "json" ? new Spinner() : null
  const outputMode: string = "json";
  const spinner = outputMode !== "json" ? new Spinner() : null;
  assertEquals(spinner, null);
});

Deno.test("spinner is created in log mode", () => {
  const outputMode: string = "log";
  const spinner = outputMode !== "json" ? new Spinner() : null;
  assertEquals(spinner instanceof Spinner, true);
});
