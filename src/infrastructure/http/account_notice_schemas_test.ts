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
import {
  MAX_NOTICE_NAME_LENGTH,
  parseAccountNotices,
  parseAccountNoticesErrorCode,
  trustedBillingPath,
} from "./account_notice_schemas.ts";
import { MAX_ACCOUNT_NOTICES } from "../../domain/account_notices/account_notice.ts";

const fixture = JSON.parse(
  await Deno.readTextFile(
    new URL("./account_notices_response.fixture.json", import.meta.url),
  ),
);

function ended(overrides: Record<string, unknown> = {}) {
  return {
    kind: "trial-ended",
    slug: "keeb",
    name: "keeb",
    personal: true,
    href: "/billing",
    ...overrides,
  };
}

Deno.test("parseAccountNotices: keeps the trial notices in server order and drops seat notices", () => {
  assertEquals(parseAccountNotices(fixture.notices), [
    {
      kind: "trial-ended",
      slug: "notice_ended",
      name: "notice_ended",
      personal: true,
      href: "/billing",
    },
    {
      kind: "trial-ending",
      slug: "acme",
      name: "Acme",
      personal: false,
      href: "/o/acme/billing",
      endsAt: "2026-11-07T12:00:00.000Z",
      daysRemaining: 5,
    },
  ]);
});

Deno.test("parseAccountNotices: an empty list is no notices", () => {
  assertEquals(parseAccountNotices(fixture.empty), []);
});

Deno.test("parseAccountNotices: an envelope that breaks the contract is undefined", () => {
  assertEquals(parseAccountNotices(null), undefined);
  assertEquals(parseAccountNotices({}), undefined);
  assertEquals(parseAccountNotices({ notices: "x" }), undefined);
});

Deno.test("parseAccountNotices: a malformed or unknown entry is dropped, not fatal", () => {
  const notices = parseAccountNotices({
    notices: [
      ended({ slug: "Not A Slug" }),
      ended({ personal: "yes" }),
      { kind: "trial-ending", slug: "a", name: "a", personal: true },
      { ...ended(), kind: "trial-ending", endsAt: "soon", daysRemaining: 2 },
      {
        ...ended(),
        kind: "trial-ending",
        endsAt: "2026-11-07T12:00:00Z",
        daysRemaining: -1,
      },
      { ...ended(), kind: "plan-changed" },
      "junk",
      ended({ slug: "kept" }),
    ],
  });
  assertEquals(notices?.map((n) => n.slug), ["kept"]);
});

Deno.test("parseAccountNotices: keeps at most the cap", () => {
  const many = Array.from(
    { length: MAX_ACCOUNT_NOTICES + 5 },
    (_, i) => ended({ slug: `c${i}` }),
  );
  assertEquals(
    parseAccountNotices({ notices: many })?.length,
    MAX_ACCOUNT_NOTICES,
  );
});

Deno.test("parseAccountNotices: cleans the collective name to one safe line", () => {
  const [notice] = parseAccountNotices({
    notices: [ended({ name: "\x1b[31mAc‮me\x1b[0m\nCrew" })],
  })!;
  assertEquals(notice.name, "Acme Crew");
  const [long] = parseAccountNotices({
    notices: [ended({ name: "x".repeat(500) })],
  })!;
  assertEquals(Array.from(long.name).length, MAX_NOTICE_NAME_LENGTH);
});

Deno.test("parseAccountNotices: a name of only zero-width joiners is blank and drops the notice", () => {
  assertEquals(
    parseAccountNotices({ notices: [ended({ name: "\u200d\u200c " })] }),
    [],
  );
});

Deno.test("parseAccountNotices: a name left empty by cleaning drops the notice", () => {
  assertEquals(
    parseAccountNotices({ notices: [ended({ name: "\x1b[0m​" })] }),
    [],
  );
});

Deno.test("parseAccountNotices: an untrusted href is dropped, the notice kept", () => {
  const [notice] = parseAccountNotices({
    notices: [ended({ href: "https://evil.example/billing" })],
  })!;
  assertEquals(notice.href, null);
});

Deno.test("trustedBillingPath: accepts relative paths on the same server", () => {
  assertEquals(trustedBillingPath("/billing"), "/billing");
  assertEquals(trustedBillingPath("/o/acme/billing"), "/o/acme/billing");
});

Deno.test("trustedBillingPath: refuses anything that could leave the server", () => {
  for (
    const raw of [
      "https://evil.example/billing",
      "//evil.example/billing",
      "/\\evil.example",
      "\\\\evil.example",
      "javascript:alert(1)",
      "billing",
      "/bill ing",
      "/billing\n",
      "/billing\u00a0Pay\u00a0here:\u00a0https://evil.example/pay",
      "/billing\u2028https://evil.example",
      "/billing\u3000x",
      "/billing\u2003x",
      "/bill‮ing",
      "",
      "/" + "a".repeat(300),
      42,
      null,
      undefined,
    ]
  ) {
    assertEquals(trustedBillingPath(raw), null, String(raw));
  }
});

Deno.test("trustedBillingPath: gives the same answer however many times it runs", () => {
  for (let i = 0; i < 4; i++) {
    assertEquals(trustedBillingPath("/bill\u202eing"), null);
    assertEquals(trustedBillingPath("/o/\u200bacme/billing"), null);
    assertEquals(trustedBillingPath("/billing"), "/billing");
  }
});

Deno.test("parseAccountNoticesErrorCode: reads the error field", () => {
  assertEquals(
    parseAccountNoticesErrorCode(fixture.collectiveKey),
    "notices_require_user",
  );
  assertEquals(parseAccountNoticesErrorCode("nope"), undefined);
});
