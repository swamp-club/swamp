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

import { assertEquals } from "@std/assert";
import { initializeLogging } from "../../infrastructure/logging/logger.ts";
import { type IssueCreateData, renderIssueCreate } from "./issue_output.ts";

await initializeLogging({});

// --- JSON output tests ---

Deno.test("renderIssueCreate json mode: created variant", () => {
  const data: IssueCreateData = {
    method: "created",
    url: "https://github.com/systeminit/swamp/issues/42",
    number: 42,
    type: "bug",
    title: "Test bug",
  };

  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);

  try {
    renderIssueCreate(data, "json");
    assertEquals(logs.length, 1);
    const parsed = JSON.parse(logs[0]);
    assertEquals(parsed.method, "created");
    assertEquals(parsed.url, "https://github.com/systeminit/swamp/issues/42");
    assertEquals(parsed.number, 42);
    assertEquals(parsed.type, "bug");
    assertEquals(parsed.title, "Test bug");
  } finally {
    console.log = originalLog;
  }
});

Deno.test("renderIssueCreate json mode: url variant includes body and labels", () => {
  const data: IssueCreateData = {
    method: "url",
    url: "https://github.com/systeminit/swamp/issues/new",
    type: "bug",
    title: "Test bug",
    body: "Bug description here",
    labels: ["bug", "external"],
  };

  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);

  try {
    renderIssueCreate(data, "json");
    assertEquals(logs.length, 1);
    const parsed = JSON.parse(logs[0]);
    assertEquals(parsed.method, "url");
    assertEquals(
      parsed.url,
      "https://github.com/systeminit/swamp/issues/new",
    );
    assertEquals(parsed.type, "bug");
    assertEquals(parsed.title, "Test bug");
    assertEquals(parsed.body, "Bug description here");
    assertEquals(parsed.labels, ["bug", "external"]);
    assertEquals(parsed.number, undefined);
  } finally {
    console.log = originalLog;
  }
});

Deno.test("renderIssueCreate json mode: feature created variant", () => {
  const data: IssueCreateData = {
    method: "created",
    url: "https://github.com/systeminit/swamp/issues/99",
    number: 99,
    type: "feature",
    title: "New feature",
  };

  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);

  try {
    renderIssueCreate(data, "json");
    const parsed = JSON.parse(logs[0]);
    assertEquals(parsed.method, "created");
    assertEquals(parsed.type, "feature");
  } finally {
    console.log = originalLog;
  }
});

// --- Log mode tests ---

Deno.test("renderIssueCreate log mode: created variant does not throw", () => {
  const data: IssueCreateData = {
    method: "created",
    url: "https://github.com/systeminit/swamp/issues/42",
    number: 42,
    type: "bug",
    title: "Test bug",
  };
  renderIssueCreate(data, "log");
});

Deno.test("renderIssueCreate log mode: url variant does not throw", () => {
  const data: IssueCreateData = {
    method: "url",
    url: "https://github.com/systeminit/swamp/issues/new",
    type: "bug",
    title: "Test bug",
    body: "Bug description",
    labels: ["bug", "external"],
  };
  renderIssueCreate(data, "log");
});

Deno.test("renderIssueCreate log mode: feature url variant does not throw", () => {
  const data: IssueCreateData = {
    method: "url",
    url: "https://github.com/systeminit/swamp/issues/new",
    type: "feature",
    title: "New feature",
    body: "Feature description",
    labels: ["enhancement", "external"],
  };
  renderIssueCreate(data, "log");
});
