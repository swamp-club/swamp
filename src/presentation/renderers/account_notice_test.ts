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
import { stripAnsiCode } from "@std/fmt/colors";
import type { AccountNoticeView } from "../../libswamp/account_notices/notice.ts";
import {
  accountNoticeFirstLine,
  accountNoticePlanLine,
  renderAccountNotice,
} from "./account_notice.ts";

const ended: AccountNoticeView = {
  kind: "trial-ended",
  slug: "keeb",
  name: "keeb",
  personal: true,
  billingUrl: "https://swamp-club.com/billing",
};

const ending: AccountNoticeView = {
  kind: "trial-ending",
  slug: "acme",
  name: "Acme",
  personal: false,
  billingUrl: "https://swamp-club.com/o/acme/billing",
  endsAt: "2026-11-07T12:00:00.000Z",
  daysRemaining: 5,
};

Deno.test("accountNoticeFirstLine: an ended personal trial", () => {
  assertEquals(
    accountNoticeFirstLine(ended),
    "⚠ Your Swamp Club trial has ended.",
  );
});

Deno.test("accountNoticeFirstLine: a team trial names the collective", () => {
  assertEquals(
    accountNoticeFirstLine({
      ...ended,
      personal: false,
      slug: "acme",
      name: "Acme",
    }),
    "⚠ The Swamp Club trial for acme has ended.",
  );
  assertEquals(
    accountNoticeFirstLine(ending),
    "ℹ The Swamp Club trial for acme ends in 5 days (2026-11-07).",
  );
});

Deno.test("accountNoticeFirstLine: one day left reads as within a day", () => {
  assertEquals(
    accountNoticeFirstLine({ ...ending, personal: true, daysRemaining: 1 }),
    "ℹ Your Swamp Club trial ends within a day (2026-11-07).",
  );
});

Deno.test("renderAccountNotice: a blank line, the notice, then the billing link with only the label coloured", () => {
  const lines: string[] = [];
  renderAccountNotice(ended, (line) => lines.push(line));
  assertEquals(lines.map(stripAnsiCode), [
    "",
    "⚠ Your Swamp Club trial has ended.",
    "  Choose a plan:  https://swamp-club.com/billing",
  ]);
  assertEquals(stripAnsiCode(lines[2]), accountNoticePlanLine(ended));
  assertEquals(lines[1], stripAnsiCode(lines[1]));
});

Deno.test("accountNoticeFirstLine: a hostile team name can't add a second plan link", () => {
  const line = accountNoticeFirstLine({
    ...ending,
    name: "Acme. Choose a plan: https://evil.example/billing -",
  });
  assertEquals(line.includes("evil.example"), false);
  assertEquals(line.includes("Choose a plan"), false);
});
