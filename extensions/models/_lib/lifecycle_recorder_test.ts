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

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import {
  type RecorderLogger,
  recordLifecycle,
  recordLifecycleBestEffort,
  recordRipple,
  recordUpstreamChange,
} from "./lifecycle_recorder.ts";
import { SwampClubClient } from "./swamp_club.ts";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

interface LoggedLine {
  level: "info" | "warning";
  props: Record<string, unknown>;
}

function buildLogger(): { logger: RecorderLogger; lines: LoggedLine[] } {
  const lines: LoggedLine[] = [];
  return {
    lines,
    logger: {
      info: (_msg, props) => lines.push({ level: "info", props }),
      warning: (_msg, props) => lines.push({ level: "warning", props }),
    },
  };
}

/** A client whose every request returns the given status and body. */
function buildClient(
  status: number,
  body: string,
): { client: SwampClubClient; restore: () => void } {
  const originalFetch = globalThis.fetch;
  globalThis.fetch =
    ((): Promise<Response> =>
      Promise.resolve(new Response(body, { status }))) as typeof fetch;
  return {
    client: new SwampClubClient("https://fake.swamp-club.com", "k", 42),
    restore: () => {
      globalThis.fetch = originalFetch;
    },
  };
}

const ENTRY = {
  step: "classified",
  targetStatus: "triaged",
  summary: "Classified as bug",
  emoji: "x",
  payload: {},
};

// ---------------------------------------------------------------------------
// No client — offline operation stays supported
// ---------------------------------------------------------------------------

Deno.test("recordLifecycle: is a quiet no-op with no client", async () => {
  await recordLifecycle(null, ENTRY);
});

Deno.test("recordLifecycleBestEffort: is a quiet no-op with no client", async () => {
  const { logger, lines } = buildLogger();
  await recordLifecycleBestEffort(null, logger, ENTRY);
  assertEquals(lines.length, 0);
});

Deno.test("recordRipple: is a quiet no-op with no client", async () => {
  await recordRipple(null, "thanks");
});

Deno.test("recordUpstreamChange: is a quiet no-op when nothing was attempted", () => {
  const { logger, lines } = buildLogger();
  recordUpstreamChange(logger, "status transition", undefined);
  assertEquals(lines.length, 0);
});

// ---------------------------------------------------------------------------
// Mandatory records raise
// ---------------------------------------------------------------------------

Deno.test("recordLifecycle: raises naming the step, status and server body", async () => {
  const body = JSON.stringify({ error: "payload keys must not start with $" });
  const { client, restore } = buildClient(400, body);
  try {
    const error = await assertRejects(
      () => recordLifecycle(client, ENTRY),
      Error,
    );
    assertStringIncludes(error.message, "classified lifecycle entry");
    assertStringIncludes(error.message, "HTTP 400");
    assertStringIncludes(error.message, "must not start with");
    assertStringIncludes(error.message, "re-run this method");
  } finally {
    restore();
  }
});

Deno.test("recordLifecycle: resolves when the entry is accepted", async () => {
  const { client, restore } = buildClient(201, "{}");
  try {
    await recordLifecycle(client, ENTRY);
  } finally {
    restore();
  }
});

Deno.test("recordRipple: raises when the ripple is not accepted", async () => {
  const { client, restore } = buildClient(403, "forbidden");
  try {
    const error = await assertRejects(
      () => recordRipple(client, "thanks"),
      Error,
    );
    assertStringIncludes(error.message, "contributor ripple");
    assertStringIncludes(error.message, "HTTP 403");
  } finally {
    restore();
  }
});

Deno.test("recordUpstreamChange: raises on a failed outcome", () => {
  const { logger } = buildLogger();
  let raised = "";
  try {
    recordUpstreamChange(logger, "status transition to triaged", {
      ok: false,
      reason: "rejected",
      status: 422,
      body: "precondition",
    });
  } catch (err) {
    raised = String(err);
  }
  assertStringIncludes(raised, "status transition to triaged");
  assertStringIncludes(raised, "HTTP 422");
});

Deno.test("recordUpstreamChange: reports an already-applied change at info", () => {
  const { logger, lines } = buildLogger();
  recordUpstreamChange(logger, "status transition to triaged", {
    ok: true,
    noop: true,
  });
  assertEquals(lines.length, 1);
  assertEquals(lines[0].level, "info");
});

Deno.test("recordUpstreamChange: stays silent on an ordinary success", () => {
  const { logger, lines } = buildLogger();
  recordUpstreamChange(logger, "status transition to triaged", { ok: true });
  assertEquals(lines.length, 0);
});

// ---------------------------------------------------------------------------
// Courtesy records warn instead
// ---------------------------------------------------------------------------

Deno.test("recordLifecycleBestEffort: warns instead of raising when rejected", async () => {
  const { client, restore } = buildClient(400, "nope");
  const { logger, lines } = buildLogger();
  try {
    await recordLifecycleBestEffort(client, logger, ENTRY);
    assertEquals(lines.length, 1);
    assertEquals(lines[0].level, "warning");
    assertStringIncludes(String(lines[0].props.message), "HTTP 400");
  } finally {
    restore();
  }
});
