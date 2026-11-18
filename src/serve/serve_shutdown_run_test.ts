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
import { waitFor } from "@swamp-club/swamp-testing";
import { ServeShutdownRun } from "./serve_shutdown_run.ts";

interface Harness {
  readonly run: ServeShutdownRun;
  readonly exits: number[];
  readonly escaped: unknown[];
  bodyRuns(): number;
}

function harness(
  body: () => Promise<void>,
  onEscaped: (error: unknown) => void = () => {},
): Harness {
  const exits: number[] = [];
  const escaped: unknown[] = [];
  let runs = 0;
  const run = new ServeShutdownRun({
    body: () => {
      runs++;
      return body();
    },
    onEscaped: (error) => {
      escaped.push(error);
      onEscaped(error);
    },
    exit: (code) => exits.push(code),
  });
  return { run, exits, escaped, bodyRuns: () => runs };
}

/** what a signal handler does: start the run and only log its failure */
function trigger(run: ServeShutdownRun): void {
  run.start().catch(() => {});
}

Deno.test("ServeShutdownRun: a shutdown that throws before its listener closes exits 1 instead of hanging", async () => {
  const failure = new Error("BrokenPipe");
  // the throw comes before the step that would close the listener
  const h = harness(async () => {
    await Promise.resolve();
    throw failure;
  });

  trigger(h.run);

  await waitFor(() => h.exits.length > 0, "the failed shutdown to exit", {
    timeoutMs: 2_000,
  });
  assertEquals(h.exits, [1]);
  assertEquals(h.escaped, [failure]);
});

Deno.test("ServeShutdownRun: a trigger after the failure neither reruns the shutdown nor exits again", async () => {
  const h = harness(() => Promise.reject(new Error("boom")));

  trigger(h.run);
  await waitFor(() => h.exits.length > 0, "the failed shutdown to exit", {
    timeoutMs: 2_000,
  });
  await assertRejects(() => h.run.start());

  assertEquals(h.bodyRuns(), 1);
  assertEquals(h.exits, [1]);
  assertEquals(h.escaped.length, 1);
});

Deno.test("ServeShutdownRun: a shutdown that throws after its listener closed exits rather than returning normally", async () => {
  const listener = Promise.withResolvers<void>();
  const h = harness(async () => {
    listener.resolve();
    await Promise.resolve();
    throw new Error("worker gateway dispose failed");
  });

  const started = h.run.start();
  await listener.promise;

  await assertRejects(() => started);
  assertEquals(h.exits, [1]);
});

Deno.test("ServeShutdownRun: a failure handler that throws still exits", async () => {
  const h = harness(
    () => Promise.reject(new Error("boom")),
    () => {
      throw new Error("stderr closed");
    },
  );

  trigger(h.run);

  await waitFor(() => h.exits.length > 0, "the failed shutdown to exit", {
    timeoutMs: 2_000,
  });
  assertEquals(h.exits, [1]);
});

Deno.test("ServeShutdownRun: a shutdown that throws synchronously exits 1", async () => {
  const h = harness(() => {
    throw new Error("sync");
  });

  trigger(h.run);

  await waitFor(() => h.exits.length > 0, "the failed shutdown to exit", {
    timeoutMs: 2_000,
  });
  assertEquals(h.exits, [1]);
});

Deno.test("ServeShutdownRun: a shutdown that completes never exits, and every trigger shares its one run", async () => {
  const h = harness(() => Promise.resolve());

  const first = h.run.start();
  const second = h.run.start();
  await first;
  await second;

  assertEquals(h.bodyRuns(), 1);
  assertEquals(h.exits, []);
  assertEquals(h.escaped, []);
});

Deno.test("ServeShutdownRun: the body starts in the turn that triggers it", () => {
  let began = false;
  const h = harness(() => {
    began = true;
    return Promise.resolve();
  });

  trigger(h.run);

  assertEquals(began, true);
});

Deno.test("ServeShutdownRun: started is unset until a trigger starts the run", async () => {
  const h = harness(() => Promise.resolve());

  assertEquals(h.run.started, undefined);
  const run = h.run.start();

  assertEquals(h.run.started, run);
  await run;
});
