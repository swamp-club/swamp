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
import { buildEditTemplate, parseEditContent } from "./issue_edit.ts";

Deno.test("parseEditContent: extracts title and body", () => {
  const content = `## Title
My Issue Title

## Body
This is the body content.

Multiple paragraphs.
`;
  const result = parseEditContent(content);
  assertEquals(result?.title, "My Issue Title");
  assertEquals(
    result?.body,
    "This is the body content.\n\nMultiple paragraphs.",
  );
});

Deno.test("parseEditContent: strips HTML comment lines", () => {
  const content = `<!-- This is a comment -->

## Title
My Title

## Body
Some body text.
`;
  const result = parseEditContent(content);
  assertEquals(result?.title, "My Title");
  assertEquals(result?.body, "Some body text.");
});

Deno.test("parseEditContent: returns null when title is missing", () => {
  const content = `## Title

## Body
Some body text.
`;
  const result = parseEditContent(content);
  assertEquals(result, null);
});

Deno.test("parseEditContent: returns empty body when body section is missing", () => {
  const content = `## Title
My Title
`;
  const result = parseEditContent(content);
  assertEquals(result?.title, "My Title");
  assertEquals(result?.body, "");
});

Deno.test("parseEditContent: returns null for completely empty content", () => {
  const result = parseEditContent("");
  assertEquals(result, null);
});

Deno.test("buildEditTemplate: round-trips through parseEditContent", () => {
  const template = buildEditTemplate("Original Title", "Original body content");
  const parsed = parseEditContent(template);
  assertEquals(parsed?.title, "Original Title");
  assertEquals(parsed?.body, "Original body content");
});

Deno.test("buildEditTemplate: round-trips multiline body", () => {
  const body = "First paragraph.\n\nSecond paragraph.\n\n- list item";
  const template = buildEditTemplate("Title", body);
  const parsed = parseEditContent(template);
  assertEquals(parsed?.title, "Title");
  assertEquals(parsed?.body, body);
});

Deno.test("buildEditTemplate: includes type section when type is provided", () => {
  const template = buildEditTemplate("Title", "Body", "bug");
  const parsed = parseEditContent(template);
  assertEquals(parsed?.title, "Title");
  assertEquals(parsed?.body, "Body");
  assertEquals(parsed?.type, "bug");
});

Deno.test("buildEditTemplate: round-trips with type", () => {
  const template = buildEditTemplate("My Title", "My body content", "security");
  const parsed = parseEditContent(template);
  assertEquals(parsed?.title, "My Title");
  assertEquals(parsed?.body, "My body content");
  assertEquals(parsed?.type, "security");
});

Deno.test("parseEditContent: extracts type from template", () => {
  const content = `## Title
My Title

## Type (bug, feature, or security)
feature

## Body
Some body text.
`;
  const result = parseEditContent(content);
  assertEquals(result?.title, "My Title");
  assertEquals(result?.type, "feature");
  assertEquals(result?.body, "Some body text.");
});

Deno.test("parseEditContent: returns undefined type when type section is absent", () => {
  const content = `## Title
My Title

## Body
Some body text.
`;
  const result = parseEditContent(content);
  assertEquals(result?.title, "My Title");
  assertEquals(result?.type, undefined);
  assertEquals(result?.body, "Some body text.");
});

Deno.test("buildEditTemplate: omits type section when type is not provided", () => {
  const template = buildEditTemplate("Title", "Body");
  const parsed = parseEditContent(template);
  assertEquals(parsed?.title, "Title");
  assertEquals(parsed?.body, "Body");
  assertEquals(parsed?.type, undefined);
});
