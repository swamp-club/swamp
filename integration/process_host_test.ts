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

import {
  assertEquals,
  assertNotStrictEquals,
  assertStrictEquals,
} from "@std/assert";
import { waitFor } from "@swamp-club/swamp-testing";
import { withMockedEnv } from "../src/infrastructure/persistence/path_test_helpers.ts";
import {
  currentProcessRuntime,
  ProcessRuntime,
} from "../src/infrastructure/runtime/process_runtime.ts";
import { startProcessHost } from "./process_host.ts";

interface Seen {
  readonly env: string | undefined;
  readonly runtime: ProcessRuntime;
}

Deno.test("startProcessHost: the host sees its own runtime and none of the caller's mocked env", async () => {
  const name = `SWAMP_PROCESS_HOST_${crypto.randomUUID().replaceAll("-", "_")}`;
  const replies: Seen[] = [];
  const host = startProcessHost<"look", Seen>(
    "observer",
    (post) => () =>
      post({ env: Deno.env.get(name), runtime: currentProcessRuntime() }),
    (reply) => replies.push(reply),
  );
  withMockedEnv({ [name]: "the test's" }, () => host.postMessage("look"));
  await waitFor(() => replies.length === 1, "the host's reply");
  assertEquals(replies[0].env, undefined);
  assertNotStrictEquals(replies[0].runtime, currentProcessRuntime());
});

Deno.test("startProcessHost: onMessage runs in the test's context, not the host's", async () => {
  const other = new ProcessRuntime(`test-${crypto.randomUUID()}`);
  let ranIn: ProcessRuntime | undefined;
  let hostRuntime: ProcessRuntime | undefined;
  other.run(() => {
    const host = startProcessHost<"ping", ProcessRuntime>(
      "pong",
      (post) => () => post(currentProcessRuntime()),
      (fromHost) => {
        hostRuntime = fromHost;
        ranIn = currentProcessRuntime();
      },
    );
    host.postMessage("ping");
  });
  await waitFor(() => ranIn !== undefined, "the reply");
  assertStrictEquals(ranIn, other);
  assertNotStrictEquals(hostRuntime, other);
});

Deno.test("startProcessHost: terminate drops the host's later replies and aborts its stopped signal", async () => {
  const replies: string[] = [];
  let stopped: AbortSignal | undefined;
  const host = startProcessHost<"reply", string>(
    "quiet",
    (post, signal) => {
      stopped = signal;
      return () => post("late");
    },
    (reply) => replies.push(reply),
  );
  host.terminate();
  host.postMessage("reply");
  await Promise.resolve();
  await new Promise<void>((done) => queueMicrotask(done));
  assertEquals(replies, []);
  assertEquals(stopped?.aborted, true);
});
