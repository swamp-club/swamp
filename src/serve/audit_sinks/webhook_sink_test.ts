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
import { WebhookSink } from "./webhook_sink.ts";

Deno.test("WebhookSink: name includes hostname from url", () => {
  const sink = new WebhookSink({
    url: "http://siem.example.com/api/ingest",
    batchIntervalMs: 60_000,
  });
  assertEquals(sink.name, "webhook:siem.example.com");
  assertEquals(sink.durable, false);
  sink.close();
});

Deno.test("WebhookSink: defaults to json format", () => {
  const sink = new WebhookSink({
    url: "http://localhost:9999/ingest",
    batchIntervalMs: 60_000,
  });
  assertEquals(sink.durable, false);
  sink.close();
});
