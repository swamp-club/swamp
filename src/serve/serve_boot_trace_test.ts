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
  findSpan,
  withCapturedSpans,
} from "../infrastructure/tracing/span_test_helpers.ts";
import {
  SERVE_BOOT_PHASE_EVENT,
  SERVE_BOOT_SPAN,
  ServeBootTrace,
} from "./serve_boot_trace.ts";

Deno.test("ServeBootTrace: one boot span holds each phase's end in order, and ends once at ready (swamp-club#4702)", async () => {
  await withCapturedSpans(async (spans) => {
    const boot = new ServeBootTrace();
    boot.phase("repo_open");
    boot.phase("listen");
    boot.end(true);
    boot.phase("late");
    boot.end(false);
    await Promise.resolve();
    const span = findSpan(spans, SERVE_BOOT_SPAN);
    assertEquals(
      spans.filter((s) => s.name === SERVE_BOOT_SPAN).length,
      1,
    );
    assertEquals(
      span.events
        .filter((event) => event.name === SERVE_BOOT_PHASE_EVENT)
        .map((event) => event.attributes?.["swamp.serve.boot.phase.name"]),
      ["repo_open", "listen"],
    );
    assertEquals(span.attributes["swamp.serve.boot.ready"], true);
  });
});

Deno.test("ServeBootTrace: a boot that ends before ready still exports its span, marked not ready (swamp-club#4702)", async () => {
  await withCapturedSpans(async (spans) => {
    {
      using boot = new ServeBootTrace();
      boot.phase("config");
    }
    await Promise.resolve();
    const span = findSpan(spans, SERVE_BOOT_SPAN);
    assertEquals(span.attributes["swamp.serve.boot.ready"], false);
  });
});
