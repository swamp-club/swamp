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

import { assertEquals, assertRejects, assertStrictEquals } from "@std/assert";
import { ShutdownRun } from "./shutdown_run.ts";

Deno.test("ShutdownRun.start: every trigger shares one run", async () => {
  let runs = 0;
  const failures: unknown[] = [];
  const shutdown = new ShutdownRun(
    () => {
      runs++;
      return Promise.resolve();
    },
    (error) => failures.push(error),
  );

  const first = shutdown.start();
  const second = shutdown.start();
  await first;

  assertStrictEquals(first, second);
  assertEquals(runs, 1);
  assertEquals(failures, []);
});

Deno.test("ShutdownRun.start: a failed run calls onFailed once and still rejects", async () => {
  const boom = new Error("stage threw");
  const failures: unknown[] = [];
  let runs = 0;
  const shutdown = new ShutdownRun(
    () => {
      runs++;
      return Promise.reject(boom);
    },
    (error) => failures.push(error),
  );

  await assertRejects(() => shutdown.start(), Error, "stage threw");
  await assertRejects(() => shutdown.start(), Error, "stage threw");

  assertEquals(runs, 1);
  assertEquals(failures, [boom]);
});

Deno.test("ShutdownRun.start: a shutdown that throws before its first await still reaches onFailed", async () => {
  const failures: unknown[] = [];
  const shutdown = new ShutdownRun(
    () => {
      throw new Error("sync throw");
    },
    (error) => failures.push(error),
  );

  await assertRejects(() => shutdown.start(), Error, "sync throw");
  assertEquals(failures.length, 1);
});

Deno.test("ShutdownRun.start: shutdown begins before start returns", () => {
  let began = false;
  const shutdown = new ShutdownRun(() => {
    began = true;
    return Promise.resolve();
  }, () => {});

  const run = shutdown.start();

  assertEquals(began, true);
  return run;
});

Deno.test("ShutdownRun.finished: rejects with a failed run's error", async () => {
  const shutdown = new ShutdownRun(
    () => Promise.reject(new Error("failed")),
    () => {},
  );

  await assertRejects(() => shutdown.start(), Error, "failed");
  await assertRejects(() => shutdown.finished(), Error, "failed");
});

Deno.test("ShutdownRun.finished: resolves after a run that succeeded", async () => {
  const shutdown = new ShutdownRun(() => Promise.resolve(), () => {});

  await shutdown.start();
  await shutdown.finished();
});

Deno.test("ShutdownRun.finished: resolves at once when no run started", async () => {
  let runs = 0;
  const shutdown = new ShutdownRun(() => {
    runs++;
    return Promise.resolve();
  }, () => {});

  await shutdown.finished();
  assertEquals(runs, 0);
});
