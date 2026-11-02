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
import type { AuthCredentials } from "../src/domain/auth/auth_credentials.ts";
import {
  type AccountNoticeDeps,
  createAccountNoticeDeps,
  refreshAccountNotices,
  showAccountNotice,
  startAccountNoticePoll,
} from "../src/libswamp/account_notices/notice.ts";
import { waitOrAbort } from "../src/libswamp/inbox/notice.ts";

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.parse("2026-11-02T12:00:00.000Z");

interface Server {
  url: string;
  requests: number;
  answer: { status: number; body: unknown };
  [Symbol.asyncDispose](): Promise<void>;
}

function startServer(): Server {
  const state: Server = {
    url: "",
    requests: 0,
    answer: { status: 200, body: { notices: [] } },
    [Symbol.asyncDispose]: async () => {
      await server.shutdown();
    },
  };
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen: () => {} },
    (request) => {
      state.requests++;
      if (new URL(request.url).pathname !== "/api/v1/account/notices") {
        return new Response("", { status: 404 });
      }
      return Response.json(state.answer.body, { status: state.answer.status });
    },
  );
  state.url = `http://127.0.0.1:${server.addr.port}`;
  return state;
}

async function tempConfigDir(): Promise<AsyncDisposable & { dir: string }> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-account-notices-" });
  return {
    dir,
    [Symbol.asyncDispose]: async () => {
      const cleanup = Deno.remove(dir, { recursive: true });
      await (Deno.build.os === "windows" ? cleanup.catch(() => {}) : cleanup);
    },
  };
}

function wire(
  serverUrl: string,
  configDir: string,
  clock: { now: number },
): AccountNoticeDeps {
  const credentials: AuthCredentials = {
    serverUrl,
    apiKey: "swamp_integration_key",
    apiKeyId: "key-1",
    username: "keeb",
  };
  return {
    ...createAccountNoticeDeps({ configDir }),
    loadCredentials: () => Promise.resolve(credentials),
    configDirWritable: () => Promise.resolve(true),
    now: () => clock.now,
    // the grace ends only on abort, so a loaded machine can't cut a poll short
    wait: (_ms, signal) => waitOrAbort(60_000, signal),
  };
}

const ending = (endsAt: number) => ({
  kind: "trial-ending",
  slug: "keeb",
  name: "keeb",
  personal: true,
  href: "/billing",
  endsAt: new Date(endsAt).toISOString(),
  daysRemaining: Math.ceil((endsAt - T0) / DAY),
});

Deno.test("account notices: a slow command polls, a later command shows the notice once a day, then it flips to ended at endsAt", async () => {
  await using server = startServer();
  await using config = await tempConfigDir();
  const clock = { now: T0 };
  const deps = wire(server.url, config.dir, clock);
  server.answer = {
    status: 200,
    body: { notices: [ending(T0 + 5 * DAY)] },
  };

  const poll = await startAccountNoticePoll(deps, { slowCommand: true });
  await poll!.settle();
  assertEquals(server.requests, 1);

  const first = await showAccountNotice(deps);
  assertEquals(first?.kind, "trial-ending");
  assertEquals(first?.daysRemaining, 5);
  assertEquals(first?.billingUrl, `${server.url}/billing`);
  assertEquals(await showAccountNotice(deps), null);

  clock.now = T0 + 2 * DAY;
  assertEquals((await showAccountNotice(deps))?.daysRemaining, 3);

  clock.now = T0 + 5 * DAY;
  assertEquals((await showAccountNotice(deps))?.kind, "trial-ended");
  assertEquals(server.requests, 1);
});

Deno.test("account notices: a cached ended trial makes a fast command poll, and a purchase clears it", async () => {
  await using server = startServer();
  await using config = await tempConfigDir();
  const clock = { now: T0 };
  const deps = wire(server.url, config.dir, clock);
  server.answer = {
    status: 200,
    body: {
      notices: [{
        kind: "trial-ended",
        slug: "keeb",
        name: "keeb",
        personal: true,
        href: "/billing",
      }],
    },
  };
  await (await startAccountNoticePoll(deps, { slowCommand: true }))!.settle();
  assertEquals((await showAccountNotice(deps))?.kind, "trial-ended");

  server.answer = { status: 200, body: { notices: [] } };
  clock.now = T0 + 15 * 60 * 1000;
  const poll = await startAccountNoticePoll(deps, { slowCommand: false });
  await poll!.settle();
  assertEquals(server.requests, 2);
  clock.now = T0 + 2 * DAY;
  assertEquals(await showAccountNotice(deps), null);
  assertEquals(
    await startAccountNoticePoll(deps, { slowCommand: false }),
    null,
  );
});

Deno.test("account notices: a collective key's 403 stops polling for good", async () => {
  await using server = startServer();
  await using config = await tempConfigDir();
  const clock = { now: T0 };
  const deps = wire(server.url, config.dir, clock);
  server.answer = { status: 403, body: { error: "notices_require_user" } };

  await (await startAccountNoticePoll(deps, { slowCommand: true }))!.settle();
  clock.now = T0 + 30 * DAY;
  assertEquals(
    await startAccountNoticePoll(deps, { slowCommand: true }),
    null,
  );
  assertEquals(server.requests, 1);
});

Deno.test("account notices: refresh returns the notices and seeds the cache a later command shows from", async () => {
  await using server = startServer();
  await using config = await tempConfigDir();
  const clock = { now: T0 };
  const deps = wire(server.url, config.dir, clock);
  server.answer = {
    status: 200,
    body: { notices: [ending(T0 + 3 * DAY)] },
  };

  const views = await refreshAccountNotices(deps);
  assertEquals(views?.map((v) => v.daysRemaining), [3]);
  assertEquals((await showAccountNotice(deps))?.kind, "trial-ending");
});
