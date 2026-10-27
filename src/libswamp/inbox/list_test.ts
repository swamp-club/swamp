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
  assert,
  assertEquals,
  assertRejects,
  assertStrictEquals,
} from "@std/assert";
import type { AuthCredentials } from "../../domain/auth/auth_credentials.ts";
import { UserError } from "../../domain/errors.ts";
import {
  type InboxListOptions,
  type InboxMessagePage,
  parseInboxMessagePage,
} from "../../infrastructure/http/inbox_schemas.ts";
import { createLibSwampContext } from "../context.ts";
import { collect } from "../testing.ts";
import { inboxList, type InboxListDeps, type InboxListEvent } from "./list.ts";

const fixture = JSON.parse(
  await Deno.readTextFile(
    new URL(
      "../../infrastructure/http/inbox_responses.fixture.json",
      import.meta.url,
    ),
  ),
);
const page: InboxMessagePage = parseInboxMessagePage(fixture.messagesPage)!;

const credentials: AuthCredentials = {
  serverUrl: "https://swamp-club.com",
  apiKey: "swamp_test_key",
  apiKeyId: "key-1",
  username: "keeb",
};

interface Call {
  serverUrl: string;
  apiKey: string;
  options: InboxListOptions;
  signal: AbortSignal;
}

function makeDeps(overrides: {
  credentials?: AuthCredentials | null;
  page?: InboxMessagePage;
  serverUrlOverride?: string;
  listMessages?: InboxListDeps["listMessages"];
} = {}): { deps: InboxListDeps; calls: Call[] } {
  const calls: Call[] = [];
  const deps: InboxListDeps = {
    loadCredentials: () =>
      Promise.resolve(
        overrides.credentials === undefined
          ? credentials
          : overrides.credentials,
      ),
    listMessages: (serverUrl, apiKey, options, signal) => {
      calls.push({ serverUrl, apiKey, options, signal });
      return overrides.listMessages
        ? overrides.listMessages(serverUrl, apiKey, options, signal)
        : Promise.resolve(overrides.page ?? page);
    },
    serverUrlOverride: overrides.serverUrlOverride,
  };
  return { deps, calls };
}

Deno.test("inboxList: by default lists unread messages, 20 at a time", async () => {
  const { deps, calls } = makeDeps();

  const events = await collect<InboxListEvent>(
    inboxList(createLibSwampContext(), deps),
  );

  assertEquals(events.slice(0, 2), [
    { kind: "loading_credentials" },
    { kind: "contacting_server", serverUrl: "https://swamp-club.com" },
  ]);
  assertEquals(calls.length, 1);
  assertEquals(calls[0].serverUrl, "https://swamp-club.com");
  assertEquals(calls[0].apiKey, "swamp_test_key");
  assertEquals(calls[0].options, { status: "unread", limit: 20 });
  assertEquals(events.at(-1)?.kind, "completed");
});

Deno.test("inboxList: passes all, limit and before through, before upper case", async () => {
  const { deps, calls } = makeDeps();

  const events = await collect<InboxListEvent>(
    inboxList(createLibSwampContext(), deps, {
      all: true,
      limit: 100,
      before: "01jbx5q8zk00000000000000zf",
    }),
  );

  assertEquals(calls[0].options, {
    status: "all",
    limit: 100,
    before: "01JBX5Q8ZK00000000000000ZF",
  });
  const last = events.at(-1);
  assert(last?.kind === "completed");
  assertEquals(last.view.status, "all");
});

Deno.test("inboxList: reduces each message to id, kind, title and dates", async () => {
  const { deps } = makeDeps();

  const events = await collect<InboxListEvent>(
    inboxList(createLibSwampContext(), deps),
  );

  const last = events.at(-1);
  assert(last?.kind === "completed");
  assertEquals(last.view.messages[0], {
    id: "01JBX5Q8ZK0000000000000104",
    kind: "announcement",
    title: "swamp 1.42 is out",
    createdAt: "2026-10-26T09:00:00.000Z",
    readAt: null,
  });
  for (const message of last.view.messages) {
    assertEquals(Object.keys(message).sort(), [
      "createdAt",
      "id",
      "kind",
      "readAt",
      "title",
    ]);
  }
});

Deno.test("inboxList: passes dropped and nextCursor through", async () => {
  const { deps } = makeDeps({
    page: { ...page, dropped: 2, nextCursor: "01JBX5Q8ZK00000000000000ZF" },
  });

  const events = await collect<InboxListEvent>(
    inboxList(createLibSwampContext(), deps),
  );

  const last = events.at(-1);
  assert(last?.kind === "completed");
  assertEquals(last.view.dropped, 2);
  assertEquals(last.view.nextCursor, "01JBX5Q8ZK00000000000000ZF");
  assertEquals(last.view.messages.length, page.messages.length);
});

Deno.test("inboxList: uses the server URL override", async () => {
  const { deps, calls } = makeDeps({
    serverUrlOverride: "https://staging.swamp-club.com",
  });

  await collect<InboxListEvent>(inboxList(createLibSwampContext(), deps));

  assertEquals(calls[0].serverUrl, "https://staging.swamp-club.com");
});

Deno.test("inboxList: not signed in is notAuthenticated, with no call", async () => {
  for (const missing of [null, { ...credentials, apiKey: "" }]) {
    const { deps, calls } = makeDeps({ credentials: missing });

    const events = await collect<InboxListEvent>(
      inboxList(createLibSwampContext(), deps),
    );

    const last = events.at(-1);
    assert(last?.kind === "error");
    assertEquals(last.error.code, "not_authenticated");
    assertEquals(calls.length, 0);
  }
});

Deno.test("inboxList: a client UserError propagates unchanged", async () => {
  const thrown = new UserError(
    "The inbox needs a personal API key; collective keys have no inbox.",
  );
  const { deps } = makeDeps({ listMessages: () => Promise.reject(thrown) });

  const error = await assertRejects(() =>
    collect<InboxListEvent>(inboxList(createLibSwampContext(), deps))
  );

  assertStrictEquals(error, thrown);
});

Deno.test("inboxList: passes ctx.signal to the client", async () => {
  const { deps, calls } = makeDeps();
  const ctx = createLibSwampContext();

  await collect<InboxListEvent>(inboxList(ctx, deps));

  assertStrictEquals(calls[0].signal, ctx.signal);
});

Deno.test("inboxList: an abort is cancelled", async () => {
  const controller = new AbortController();
  const { deps } = makeDeps({
    listMessages: () => {
      controller.abort();
      return Promise.reject(new DOMException("aborted", "AbortError"));
    },
  });

  const events = await collect<InboxListEvent>(
    inboxList(createLibSwampContext({ signal: controller.signal }), deps),
  );

  const last = events.at(-1);
  assert(last?.kind === "error");
  assertEquals(last.error.code, "cancelled");
});

Deno.test("inboxList: refused input makes no call and loads no credentials", async () => {
  for (
    const input of [
      { limit: 0 },
      { limit: 101 },
      { limit: 1.5 },
      { before: "not-an-id" },
      { before: "01JBX5Q8ZK00000000000000ZF; rm -rf ~" },
    ]
  ) {
    let loaded = false;
    const { deps, calls } = makeDeps();
    deps.loadCredentials = () => {
      loaded = true;
      return Promise.resolve(credentials);
    };

    const events = await collect<InboxListEvent>(
      inboxList(createLibSwampContext(), deps, input),
    );

    assertEquals(events.length, 1, JSON.stringify(input));
    assert(events[0].kind === "error");
    assertEquals(events[0].error.code, "validation_failed");
    assertEquals(loaded, false);
    assertEquals(calls.length, 0);
  }
});
