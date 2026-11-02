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
import { waitFor } from "@swamp-club/swamp-testing";
import { createRequestRunner } from "./request_runner.ts";
import { readHandlers, type ReadState } from "./useRequest.ts";
import type { RequestErrorInfo } from "./stream.ts";

/** The hook state a read leaves behind, plus the replies the test answers. */
function hookState() {
  const replies: PromiseWithResolvers<string>[] = [];
  const shown = {
    data: null as string | null,
    loading: false,
    error: null as string | null,
    errorInfo: null as RequestErrorInfo | null,
  };
  const state: ReadState<string> = {
    setData: (value) => (shown.data = value),
    setLoading: (value) => (shown.loading = value),
    setError: (value) => (shown.error = value),
    setErrorInfo: (value) => (shown.errorInfo = value),
  };
  const request = () => {
    const reply = Promise.withResolvers<string>();
    replies.push(reply);
    return reply.promise;
  };
  return { replies, shown, ...readHandlers(request, state) };
}

Deno.test("readHandlers: a read shows loading and clears the last error when it goes out", async () => {
  const runner = createRequestRunner();
  const read = hookState();
  const failed = runner.send(read.start, read.apply);
  read.replies[0].reject(new Error("slow"));
  await failed;
  assertEquals(read.shown.error, "slow");
  assertEquals(read.shown.loading, false);
  const next = runner.send(read.start, read.apply);
  assertEquals(read.shown, {
    data: null,
    loading: true,
    error: null,
    errorInfo: null,
  });
  read.replies[1].resolve("v2");
  await next;
  assertEquals(read.shown.data, "v2");
  assertEquals(read.shown.loading, false);
});

Deno.test("readHandlers: a refresh's read clears the failure of the read it waited for (swamp-club#3960)", async () => {
  const runner = createRequestRunner();
  const read = hookState();
  runner.send(read.start, read.apply).catch(() => {});
  const refreshed = runner.refresh(read.start, read.apply);
  read.replies[0].reject(new Error("WebSocket closed"));
  await waitFor(() => read.replies.length === 2, "the refresh's read");
  assertEquals(read.shown.error, null);
  assertEquals(read.shown.loading, true);
  read.replies[1].resolve("v2");
  await refreshed;
  assertEquals(read.shown, {
    data: "v2",
    loading: false,
    error: null,
    errorInfo: null,
  });
});
