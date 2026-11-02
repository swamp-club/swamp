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

// drift guard: the renderer, the design doc and the swamp skill change together

import { assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { ROOT } from "./arch_fitness_helpers.ts";
import {
  accountNoticeFirstLine,
  accountNoticePlanLine,
} from "../src/presentation/renderers/account_notice.ts";
import type { AccountNoticeView } from "../src/libswamp/account_notices/notice.ts";

const DESIGN_DOC = join(ROOT, "design", "surfaces", "account-notices.md");
const SWAMP_SKILL = join(ROOT, ".claude", "skills", "swamp", "SKILL.md");

const ended: AccountNoticeView = {
  kind: "trial-ended",
  slug: "keeb",
  name: "keeb",
  personal: true,
  billingUrl: "https://swamp-club.com/billing",
};

const ending: AccountNoticeView = {
  ...ended,
  kind: "trial-ending",
  endsAt: "2026-11-07T12:00:00.000Z",
  daysRemaining: 5,
};

Deno.test("account notice: every line the renderer prints matches the design doc", async () => {
  const doc = await Deno.readTextFile(DESIGN_DOC);
  for (
    const line of [
      accountNoticeFirstLine(ended),
      accountNoticeFirstLine(ending),
      accountNoticeFirstLine({
        ...ended,
        personal: false,
        slug: "acme",
        name: "Acme",
      }),
      accountNoticePlanLine(ended),
    ]
  ) {
    assertStringIncludes(doc, line);
  }
  assertStringIncludes(doc, "ends within a day");
});

Deno.test("account notice: the swamp skill quotes the label agents look for", async () => {
  assertStringIncludes(
    await Deno.readTextFile(SWAMP_SKILL),
    "`Choose a plan:`",
  );
});
