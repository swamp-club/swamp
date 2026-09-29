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
import { WebhookRejectionCoalescer } from "./webhook_audit_coalescer.ts";

Deno.test("WebhookRejectionCoalescer: writes the first rejection and counts the rest of the window", () => {
  let now = 0;
  const coalescer = new WebhookRejectionCoalescer({
    windowMs: 1000,
    now: () => now,
  });
  assertEquals(coalescer.admit("/gh", "Invalid signature"), {
    emit: true,
    suppressed: 0,
  });
  now = 10;
  assertEquals(coalescer.admit("/gh", "Invalid signature").emit, false);
  now = 20;
  assertEquals(coalescer.admit("/gh", "Invalid signature").emit, false);
  now = 1000;
  assertEquals(coalescer.admit("/gh", "Invalid signature"), {
    emit: true,
    suppressed: 2,
  });
});

Deno.test("WebhookRejectionCoalescer: routes and reasons are coalesced separately", () => {
  const coalescer = new WebhookRejectionCoalescer({ now: () => 0 });
  assertEquals(coalescer.admit("/gh", "Invalid signature").emit, true);
  assertEquals(coalescer.admit("/gh", "Queue full").emit, true);
  assertEquals(coalescer.admit("/stripe", "Invalid signature").emit, true);
  assertEquals(coalescer.admit("/gh", "Invalid signature").emit, false);
});

Deno.test("WebhookRejectionCoalescer: a flood writes one event per window", () => {
  let now = 0;
  const coalescer = new WebhookRejectionCoalescer({
    windowMs: 1000,
    now: () => now,
  });
  let written = 0;
  for (let i = 0; i < 10_000; i++) {
    now = i;
    if (coalescer.admit("/gh", "Invalid signature").emit) written++;
  }
  assertEquals(written, 10);
});
