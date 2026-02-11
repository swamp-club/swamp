// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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

import { assertEquals, assertThrows } from "@std/assert";
import {
  buildJournalctlArgs,
  JournalctlInputAttributesSchema,
} from "./journalctl_model.ts";

// Schema validation tests

Deno.test("JournalctlInputAttributesSchema accepts empty object", () => {
  const result = JournalctlInputAttributesSchema.parse({});
  assertEquals(result, {});
});

Deno.test("JournalctlInputAttributesSchema accepts unit", () => {
  const result = JournalctlInputAttributesSchema.parse({
    unit: "nginx.service",
  });
  assertEquals(result.unit, "nginx.service");
});

Deno.test("JournalctlInputAttributesSchema accepts since", () => {
  const result = JournalctlInputAttributesSchema.parse({
    since: "1 hour ago",
  });
  assertEquals(result.since, "1 hour ago");
});

Deno.test("JournalctlInputAttributesSchema accepts until", () => {
  const result = JournalctlInputAttributesSchema.parse({
    until: "2024-01-01 12:00:00",
  });
  assertEquals(result.until, "2024-01-01 12:00:00");
});

Deno.test("JournalctlInputAttributesSchema accepts positive lines", () => {
  const result = JournalctlInputAttributesSchema.parse({
    lines: 100,
  });
  assertEquals(result.lines, 100);
});

Deno.test("JournalctlInputAttributesSchema rejects zero lines", () => {
  assertThrows(
    () => JournalctlInputAttributesSchema.parse({ lines: 0 }),
    Error,
  );
});

Deno.test("JournalctlInputAttributesSchema rejects negative lines", () => {
  assertThrows(
    () => JournalctlInputAttributesSchema.parse({ lines: -5 }),
    Error,
  );
});

Deno.test("JournalctlInputAttributesSchema accepts priority", () => {
  const result = JournalctlInputAttributesSchema.parse({
    priority: "err",
  });
  assertEquals(result.priority, "err");
});

Deno.test("JournalctlInputAttributesSchema accepts boot 0", () => {
  const result = JournalctlInputAttributesSchema.parse({
    boot: 0,
  });
  assertEquals(result.boot, 0);
});

Deno.test("JournalctlInputAttributesSchema accepts negative boot", () => {
  const result = JournalctlInputAttributesSchema.parse({
    boot: -1,
  });
  assertEquals(result.boot, -1);
});

Deno.test("JournalctlInputAttributesSchema accepts grep", () => {
  const result = JournalctlInputAttributesSchema.parse({
    grep: "error",
  });
  assertEquals(result.grep, "error");
});

Deno.test("JournalctlInputAttributesSchema accepts identifier", () => {
  const result = JournalctlInputAttributesSchema.parse({
    identifier: "sshd",
  });
  assertEquals(result.identifier, "sshd");
});

Deno.test("JournalctlInputAttributesSchema accepts all attributes", () => {
  const result = JournalctlInputAttributesSchema.parse({
    unit: "nginx.service",
    since: "1 hour ago",
    until: "now",
    lines: 50,
    priority: "warning",
    boot: 0,
    grep: "error",
    identifier: "nginx",
  });
  assertEquals(result.unit, "nginx.service");
  assertEquals(result.since, "1 hour ago");
  assertEquals(result.until, "now");
  assertEquals(result.lines, 50);
  assertEquals(result.priority, "warning");
  assertEquals(result.boot, 0);
  assertEquals(result.grep, "error");
  assertEquals(result.identifier, "nginx");
});

// buildJournalctlArgs tests

Deno.test("buildJournalctlArgs returns --no-pager for empty attributes", () => {
  const args = buildJournalctlArgs({});
  assertEquals(args, ["--no-pager"]);
});

Deno.test("buildJournalctlArgs includes unit", () => {
  const args = buildJournalctlArgs({ unit: "sshd.service" });
  assertEquals(args.includes("--unit=sshd.service"), true);
  assertEquals(args.includes("--no-pager"), true);
});

Deno.test("buildJournalctlArgs includes since", () => {
  const args = buildJournalctlArgs({ since: "yesterday" });
  assertEquals(args.includes("--since=yesterday"), true);
});

Deno.test("buildJournalctlArgs includes until", () => {
  const args = buildJournalctlArgs({ until: "today" });
  assertEquals(args.includes("--until=today"), true);
});

Deno.test("buildJournalctlArgs includes lines", () => {
  const args = buildJournalctlArgs({ lines: 100 });
  assertEquals(args.includes("--lines=100"), true);
});

Deno.test("buildJournalctlArgs includes priority", () => {
  const args = buildJournalctlArgs({ priority: "err" });
  assertEquals(args.includes("--priority=err"), true);
});

Deno.test("buildJournalctlArgs includes boot 0", () => {
  const args = buildJournalctlArgs({ boot: 0 });
  assertEquals(args.includes("--boot=0"), true);
});

Deno.test("buildJournalctlArgs includes negative boot", () => {
  const args = buildJournalctlArgs({ boot: -1 });
  assertEquals(args.includes("--boot=-1"), true);
});

Deno.test("buildJournalctlArgs includes grep", () => {
  const args = buildJournalctlArgs({ grep: "failed" });
  assertEquals(args.includes("--grep=failed"), true);
});

Deno.test("buildJournalctlArgs includes identifier", () => {
  const args = buildJournalctlArgs({ identifier: "kernel" });
  assertEquals(args.includes("--identifier=kernel"), true);
});

Deno.test("buildJournalctlArgs combines multiple attributes", () => {
  const args = buildJournalctlArgs({
    unit: "nginx.service",
    lines: 10,
    priority: "warning",
  });

  assertEquals(args.includes("--unit=nginx.service"), true);
  assertEquals(args.includes("--lines=10"), true);
  assertEquals(args.includes("--priority=warning"), true);
  assertEquals(args.includes("--no-pager"), true);
  assertEquals(args.length, 4);
});

Deno.test("buildJournalctlArgs handles time range", () => {
  const args = buildJournalctlArgs({
    since: "2024-01-01 00:00:00",
    until: "2024-01-01 23:59:59",
  });

  assertEquals(args.includes("--since=2024-01-01 00:00:00"), true);
  assertEquals(args.includes("--until=2024-01-01 23:59:59"), true);
});
