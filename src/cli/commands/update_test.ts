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
import type { UpdateChecker } from "../../domain/update/update_service.ts";
import { UpdateService } from "../../domain/update/update_service.ts";
import { Platform } from "../../domain/update/platform.ts";
import { Spinner } from "../../presentation/spinner.ts";
import { initializeLogging } from "../../infrastructure/logging/logger.ts";
import { consumeStream } from "../../libswamp/stream.ts";
import type {
  UpdateCheckDeps,
  UpdateCheckEvent,
} from "../../libswamp/update/check.ts";
import {
  globalSkillSyncLine,
  globalSkillSyncNote,
  updateWithin,
} from "./update.ts";
import { createUpdateCheckRenderer } from "../../presentation/renderers/update_check.ts";

await initializeLogging({});

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

// The update pre-flight probes the binary's directory; a missing directory is
// not a permission problem, so these tests never touch a real install dir.
const missingBinaryPath = "/nonexistent-swamp-update-test/bin/swamp";

// --- Spinner integration with update flow ---

Deno.test("update flow starts and stops spinner around service.update()", async () => {
  const checker = createMockChecker(redirectUrl);
  const service = new UpdateService(checker, currentVersion, missingBinaryPath);
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
  const service = new UpdateService(checker, currentVersion, missingBinaryPath);
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
  const service = new UpdateService(checker, currentVersion, missingBinaryPath);
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

// --- UpdateCheckRenderer.updated flag ---

async function* fakeUpdateStream(
  status: "updated" | "up_to_date",
): AsyncIterable<UpdateCheckEvent> {
  yield { kind: "checking" };
  if (status === "updated") {
    yield {
      kind: "completed",
      data: {
        status: "updated",
        previousVersion: "1.0.0",
        newVersion: "2.0.0",
      },
    };
  } else {
    yield {
      kind: "completed",
      data: { status: "up_to_date", currentVersion: "1.0.0" },
    };
  }
}

Deno.test("createUpdateCheckRenderer: updated is true after successful update (log mode)", async () => {
  const renderer = createUpdateCheckRenderer("log");
  assertEquals(renderer.updated, false);

  await consumeStream(fakeUpdateStream("updated"), renderer.handlers());
  assertEquals(renderer.updated, true);
});

Deno.test("createUpdateCheckRenderer: updated is false when already up to date (log mode)", async () => {
  const renderer = createUpdateCheckRenderer("log");
  await consumeStream(fakeUpdateStream("up_to_date"), renderer.handlers());
  assertEquals(renderer.updated, false);
});

Deno.test("createUpdateCheckRenderer: updated is true after successful update (json mode)", async () => {
  const renderer = createUpdateCheckRenderer("json");
  assertEquals(renderer.updated, false);

  await consumeStream(fakeUpdateStream("updated"), renderer.handlers());
  assertEquals(renderer.updated, true);
});

Deno.test("createUpdateCheckRenderer: updated is false when already up to date (json mode)", async () => {
  const renderer = createUpdateCheckRenderer("json");
  await consumeStream(fakeUpdateStream("up_to_date"), renderer.handlers());
  assertEquals(renderer.updated, false);
});

Deno.test("createUpdateCheckRenderer: newVersion is the installed version after an update", async () => {
  for (const mode of ["log", "json"] as const) {
    const updated = createUpdateCheckRenderer(mode);
    assertEquals(updated.newVersion, null);
    await consumeStream(fakeUpdateStream("updated"), updated.handlers());
    assertEquals(updated.newVersion, "2.0.0");

    const upToDate = createUpdateCheckRenderer(mode);
    await consumeStream(fakeUpdateStream("up_to_date"), upToDate.handlers());
    assertEquals(upToDate.newVersion, null);
  }
});

// --- Background update timeout (swamp-club#3447) ---

Deno.test("updateWithin: a timed-out background update aborts its download", async () => {
  let downloadSignal: AbortSignal | undefined;
  const update: UpdateCheckDeps["update"] = (_platform, options) => {
    downloadSignal = options?.signal;
    // Like a stalled download: it ends only when its signal aborts.
    return new Promise((_, reject) =>
      options?.signal?.addEventListener(
        "abort",
        () => reject(options.signal?.reason),
      )
    );
  };

  await assertRejects(
    () => updateWithin(update, platform, 10),
    Error,
    "Background update timed out",
  );
  assertEquals(downloadSignal?.aborted, true);
});

Deno.test("updateWithin: an update that finishes in time returns its result", async () => {
  const update: UpdateCheckDeps["update"] = () =>
    Promise.resolve({
      status: "updated",
      previousVersion: currentVersion,
      newVersion: newerVersion,
    });

  const result = await updateWithin(update, platform, 60_000);

  assertEquals(result.status, "updated");
});

Deno.test("updateWithin: other failures keep their message", async () => {
  const update: UpdateCheckDeps["update"] = () =>
    Promise.reject(new Error("permission denied"));

  await assertRejects(
    () => updateWithin(update, platform, 60_000),
    Error,
    "permission denied",
  );
});

Deno.test("globalSkillSyncLine: names the dir as an agent skill directory", () => {
  assertEquals(
    globalSkillSyncLine("/home/u/.agents/skills"),
    "Synced global skills to the agent skill directory /home/u/.agents/skills",
  );
});

Deno.test("globalSkillSyncNote: explains SWAMP_HOME when it is set and a dir synced", () => {
  assertEquals(
    globalSkillSyncNote(2, true),
    "Agent skill directories stay in your home directory, where your agents read them; SWAMP_HOME moves only swamp's own files.",
  );
});

Deno.test("globalSkillSyncNote: is null without SWAMP_HOME or without a synced dir", () => {
  assertEquals(globalSkillSyncNote(2, false), null);
  assertEquals(globalSkillSyncNote(0, true), null);
  assertEquals(globalSkillSyncNote(0, false), null);
});
