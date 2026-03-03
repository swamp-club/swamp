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
import {
  GarbageCollectionSchema,
  type Lifetime,
  normalizeLifetime,
} from "./data_metadata.ts";

// --- normalizeLifetime: zero-duration strings become "workflow" ---

Deno.test("normalizeLifetime - converts '0h' to 'workflow'", () => {
  assertEquals(normalizeLifetime("0h"), "workflow");
});

Deno.test("normalizeLifetime - converts '0m' to 'workflow'", () => {
  assertEquals(normalizeLifetime("0m"), "workflow");
});

Deno.test("normalizeLifetime - converts '0d' to 'workflow'", () => {
  assertEquals(normalizeLifetime("0d"), "workflow");
});

Deno.test("normalizeLifetime - converts '0w' to 'workflow'", () => {
  assertEquals(normalizeLifetime("0w"), "workflow");
});

Deno.test("normalizeLifetime - converts '0mo' to 'workflow'", () => {
  assertEquals(normalizeLifetime("0mo"), "workflow");
});

Deno.test("normalizeLifetime - converts '0y' to 'workflow'", () => {
  assertEquals(normalizeLifetime("0y"), "workflow");
});

// --- normalizeLifetime: leading zeros that still equal zero ---

Deno.test("normalizeLifetime - converts '00d' to 'workflow'", () => {
  assertEquals(normalizeLifetime("00d"), "workflow");
});

Deno.test("normalizeLifetime - converts '000h' to 'workflow'", () => {
  assertEquals(normalizeLifetime("000h"), "workflow");
});

Deno.test("normalizeLifetime - converts '00mo' to 'workflow'", () => {
  assertEquals(normalizeLifetime("00mo"), "workflow");
});

Deno.test("normalizeLifetime - converts '0000w' to 'workflow'", () => {
  assertEquals(normalizeLifetime("0000w"), "workflow");
});

// --- normalizeLifetime: non-zero durations pass through unchanged ---

Deno.test("normalizeLifetime - passes through '1h' unchanged", () => {
  assertEquals(normalizeLifetime("1h"), "1h");
});

Deno.test("normalizeLifetime - passes through '5m' unchanged", () => {
  assertEquals(normalizeLifetime("5m"), "5m");
});

Deno.test("normalizeLifetime - passes through '10d' unchanged", () => {
  assertEquals(normalizeLifetime("10d"), "10d");
});

Deno.test("normalizeLifetime - passes through '2w' unchanged", () => {
  assertEquals(normalizeLifetime("2w"), "2w");
});

Deno.test("normalizeLifetime - passes through '1mo' unchanged", () => {
  assertEquals(normalizeLifetime("1mo"), "1mo");
});

Deno.test("normalizeLifetime - passes through '10y' unchanged", () => {
  assertEquals(normalizeLifetime("10y"), "10y");
});

Deno.test("normalizeLifetime - passes through '24h' unchanged", () => {
  assertEquals(normalizeLifetime("24h"), "24h");
});

Deno.test("normalizeLifetime - passes through '100d' unchanged", () => {
  assertEquals(normalizeLifetime("100d"), "100d");
});

// --- normalizeLifetime: leading zeros on non-zero values pass through ---

Deno.test("normalizeLifetime - passes through '01d' unchanged (value is 1)", () => {
  assertEquals(normalizeLifetime("01d" as Lifetime), "01d");
});

Deno.test("normalizeLifetime - passes through '007h' unchanged (value is 7)", () => {
  assertEquals(normalizeLifetime("007h" as Lifetime), "007h");
});

// --- normalizeLifetime: special lifetime values pass through unchanged ---

Deno.test("normalizeLifetime - passes through 'ephemeral' unchanged", () => {
  assertEquals(normalizeLifetime("ephemeral"), "ephemeral");
});

Deno.test("normalizeLifetime - passes through 'infinite' unchanged", () => {
  assertEquals(normalizeLifetime("infinite"), "infinite");
});

Deno.test("normalizeLifetime - passes through 'job' unchanged", () => {
  assertEquals(normalizeLifetime("job"), "job");
});

Deno.test("normalizeLifetime - passes through 'workflow' unchanged", () => {
  assertEquals(normalizeLifetime("workflow"), "workflow");
});

// --- GarbageCollectionSchema: rejects zero-duration strings ---

Deno.test("GarbageCollectionSchema - rejects '0h'", () => {
  const result = GarbageCollectionSchema.safeParse("0h");
  assertEquals(result.success, false);
});

Deno.test("GarbageCollectionSchema - rejects '0d'", () => {
  const result = GarbageCollectionSchema.safeParse("0d");
  assertEquals(result.success, false);
});

Deno.test("GarbageCollectionSchema - rejects '0w'", () => {
  const result = GarbageCollectionSchema.safeParse("0w");
  assertEquals(result.success, false);
});

Deno.test("GarbageCollectionSchema - rejects '0m'", () => {
  const result = GarbageCollectionSchema.safeParse("0m");
  assertEquals(result.success, false);
});

Deno.test("GarbageCollectionSchema - rejects '0mo'", () => {
  const result = GarbageCollectionSchema.safeParse("0mo");
  assertEquals(result.success, false);
});

Deno.test("GarbageCollectionSchema - rejects '0y'", () => {
  const result = GarbageCollectionSchema.safeParse("0y");
  assertEquals(result.success, false);
});

Deno.test("GarbageCollectionSchema - rejects '00d'", () => {
  const result = GarbageCollectionSchema.safeParse("00d");
  assertEquals(result.success, false);
});

Deno.test("GarbageCollectionSchema - rejects '000w'", () => {
  const result = GarbageCollectionSchema.safeParse("000w");
  assertEquals(result.success, false);
});

// --- GarbageCollectionSchema: rejects zero as a number ---

Deno.test("GarbageCollectionSchema - rejects 0 (number)", () => {
  const result = GarbageCollectionSchema.safeParse(0);
  assertEquals(result.success, false);
});

Deno.test("GarbageCollectionSchema - rejects negative numbers", () => {
  const result = GarbageCollectionSchema.safeParse(-1);
  assertEquals(result.success, false);
});

// --- GarbageCollectionSchema: accepts valid values ---

Deno.test("GarbageCollectionSchema - accepts positive integer", () => {
  const result = GarbageCollectionSchema.safeParse(5);
  assertEquals(result.success, true);
});

Deno.test("GarbageCollectionSchema - accepts '1h'", () => {
  const result = GarbageCollectionSchema.safeParse("1h");
  assertEquals(result.success, true);
});

Deno.test("GarbageCollectionSchema - accepts '30d'", () => {
  const result = GarbageCollectionSchema.safeParse("30d");
  assertEquals(result.success, true);
});

Deno.test("GarbageCollectionSchema - accepts '2w'", () => {
  const result = GarbageCollectionSchema.safeParse("2w");
  assertEquals(result.success, true);
});

Deno.test("GarbageCollectionSchema - accepts '1mo'", () => {
  const result = GarbageCollectionSchema.safeParse("1mo");
  assertEquals(result.success, true);
});

Deno.test("GarbageCollectionSchema - accepts '10y'", () => {
  const result = GarbageCollectionSchema.safeParse("10y");
  assertEquals(result.success, true);
});

// --- GarbageCollectionSchema: accepts leading-zero non-zero values ---

Deno.test("GarbageCollectionSchema - accepts '01d' (leading zero, value is 1)", () => {
  const result = GarbageCollectionSchema.safeParse("01d");
  assertEquals(result.success, true);
});

Deno.test("GarbageCollectionSchema - accepts '007h' (leading zeros, value is 7)", () => {
  const result = GarbageCollectionSchema.safeParse("007h");
  assertEquals(result.success, true);
});
