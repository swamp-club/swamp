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

// Drift guard: the inbox notice's text is pinned in three places that must
// change together (design/surfaces/inbox.md, "The notice"). The renderer
// prints it, the design doc pins it, and the `swamp` skill's rule 4 quotes the
// second line so agents recognise the notice and relay it.

import { assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { ROOT } from "./arch_fitness_helpers.ts";
import {
  INBOX_NOTICE_READ_LINE,
  INBOX_NOTICE_SINGLE_LINE,
  inboxNoticeFirstLine,
} from "../src/presentation/renderers/inbox_notice.ts";

const DESIGN_DOC = join(ROOT, "design", "surfaces", "inbox.md");
const SWAMP_SKILL = join(ROOT, ".claude", "skills", "swamp", "SKILL.md");

Deno.test("inbox notice: the second line matches the design doc and the swamp skill", async () => {
  const readLine = INBOX_NOTICE_READ_LINE.trim();
  assertStringIncludes(await Deno.readTextFile(DESIGN_DOC), readLine);
  assertStringIncludes(await Deno.readTextFile(SWAMP_SKILL), readLine);
});

Deno.test("inbox notice: both first lines match the design doc", async () => {
  const doc = await Deno.readTextFile(DESIGN_DOC);
  assertStringIncludes(doc, INBOX_NOTICE_SINGLE_LINE);
  assertStringIncludes(doc, inboxNoticeFirstLine(3));
});

Deno.test("inbox notice: the plural line counts unread messages, not new ones", async () => {
  // The count includes messages announced before, so "new" would overstate.
  const plural = "ℹ 3 unread messages from Swamp Club are waiting for you.";
  assertEquals(inboxNoticeFirstLine(3), plural);
  assertStringIncludes(await Deno.readTextFile(DESIGN_DOC), plural);
});
