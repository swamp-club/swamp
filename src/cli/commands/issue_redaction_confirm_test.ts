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
import type { RedactionSummary } from "../../domain/issues/content_redactor.ts";
import {
  chooseSubmittedContent,
  confirmRedactions,
  type RedactionConfirmDeps,
} from "./issue_redaction_confirm.ts";

const redactedOnce: RedactionSummary = {
  totalRedactions: 1,
  categories: new Map([["secret", 1]]),
};

const nothingRedacted: RedactionSummary = {
  totalRedactions: 0,
  categories: new Map(),
};

function fakeDeps(
  answer: string,
  interactive = true,
): RedactionConfirmDeps & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    isInteractive: () => interactive,
    ask: (message) => {
      asked.push(message);
      return Promise.resolve(answer);
    },
  };
}

Deno.test("confirmRedactions: y or yes submits the redacted text", async () => {
  for (const answer of ["y", "Y", "yes"]) {
    const deps = fakeDeps(answer);
    assertEquals(
      await confirmRedactions(redactedOnce, "log", deps),
      "redacted",
    );
    assertEquals(deps.asked.length, 1);
  }
});

Deno.test("confirmRedactions: w submits the text as written", async () => {
  for (const answer of ["w", "W"]) {
    assertEquals(
      await confirmRedactions(redactedOnce, "log", fakeDeps(answer)),
      "as-written",
    );
  }
});

Deno.test("confirmRedactions: any other answer or EOF cancels", async () => {
  for (const answer of ["", "n", "no", "x"]) {
    assertEquals(
      await confirmRedactions(redactedOnce, "log", fakeDeps(answer)),
      "cancel",
    );
  }
});

Deno.test("confirmRedactions: never asks in json mode, without a terminal, or when nothing was redacted", async () => {
  const cases: Array<[RedactionSummary, "log" | "json", boolean]> = [
    [redactedOnce, "json", true],
    [redactedOnce, "log", false],
    [nothingRedacted, "log", true],
  ];
  for (const [summary, mode, interactive] of cases) {
    const deps = fakeDeps("n", interactive);
    assertEquals(await confirmRedactions(summary, mode, deps), "redacted");
    assertEquals(deps.asked.length, 0);
  }
});

Deno.test("confirmRedactions: written also submits the text as written", async () => {
  assertEquals(
    await confirmRedactions(redactedOnce, "log", fakeDeps("written")),
    "as-written",
  );
});

Deno.test("chooseSubmittedContent: returns the redacted content, the original, or null on cancel", async () => {
  const content = {
    redacted: { title: "t", body: "at [IP-1]" },
    original: { title: "t", body: "at 10.20.30.40" },
  };
  const cases: Array<[string, typeof content.redacted | null]> = [
    ["y", content.redacted],
    ["w", content.original],
    ["n", null],
    ["", null],
  ];
  for (const [answer, expected] of cases) {
    assertEquals(
      await chooseSubmittedContent(
        redactedOnce,
        "log",
        content,
        fakeDeps(answer),
      ),
      expected,
      answer,
    );
  }
});

Deno.test("chooseSubmittedContent: without a terminal returns the redacted content unasked", async () => {
  const deps = fakeDeps("w", false);
  assertEquals(
    await chooseSubmittedContent(
      redactedOnce,
      "log",
      { redacted: "at [IP-1]", original: "at 10.20.30.40" },
      deps,
    ),
    "at [IP-1]",
  );
  assertEquals(deps.asked.length, 0);
});
