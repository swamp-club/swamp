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
  AuditPolicy,
  classifyTier,
  DEFAULT_AUDIT_POLICY,
} from "./audit_policy.ts";

Deno.test("classifyTier: management actions", () => {
  assertEquals(classifyTier("audit.query"), "management");
  assertEquals(classifyTier("audit.verify"), "management");
  assertEquals(classifyTier("audit.subscribe"), "management");
  assertEquals(classifyTier("serve.reload"), "management");
  assertEquals(classifyTier("serve.health"), "management");
});

Deno.test("classifyTier: system category is management tier", () => {
  assertEquals(classifyTier("instance.start", "system"), "management");
  assertEquals(classifyTier("instance.stop", "system"), "management");
});

Deno.test("classifyTier: non-system category with data action is data tier", () => {
  assertEquals(classifyTier("model.run", "execution"), "data");
});

Deno.test("classifyTier: data actions", () => {
  assertEquals(classifyTier("model.method.run"), "data");
  assertEquals(classifyTier("vault.get"), "data");
  assertEquals(classifyTier("data.get"), "data");
  assertEquals(classifyTier("workflow.run"), "data");
});

Deno.test("AuditPolicy: returns default level when no rules match", () => {
  const policy = new AuditPolicy([], "requestResponse");
  assertEquals(
    policy.evaluate("execution", "model.method.run"),
    "requestResponse",
  );
});

Deno.test("AuditPolicy: matches by category", () => {
  const policy = new AuditPolicy([
    { category: "secrets", level: "requestResponse" },
  ], "metadata");
  assertEquals(policy.evaluate("secrets", "vault.get"), "requestResponse");
  assertEquals(policy.evaluate("execution", "model.method.run"), "metadata");
});

Deno.test("AuditPolicy: matches by action", () => {
  const policy = new AuditPolicy([
    { action: "vault.get", level: "none" },
  ], "metadata");
  assertEquals(policy.evaluate("secrets", "vault.get"), "none");
  assertEquals(policy.evaluate("secrets", "vault.put"), "metadata");
});

Deno.test("AuditPolicy: matches by tier", () => {
  const policy = new AuditPolicy([
    { tier: "management", level: "none" },
  ], "request");
  assertEquals(policy.evaluate("admin", "audit.query"), "none");
  assertEquals(policy.evaluate("execution", "model.method.run"), "request");
});

Deno.test("AuditPolicy: first matching rule wins", () => {
  const policy = new AuditPolicy([
    { category: "secrets", level: "requestResponse" },
    { category: "secrets", action: "vault.get", level: "none" },
  ], "metadata");
  assertEquals(policy.evaluate("secrets", "vault.get"), "requestResponse");
});

Deno.test("AuditPolicy: combined category and action match", () => {
  const policy = new AuditPolicy([
    { category: "secrets", action: "vault.get", level: "requestResponse" },
    { category: "secrets", level: "metadata" },
  ], "none");
  assertEquals(policy.evaluate("secrets", "vault.get"), "requestResponse");
  assertEquals(policy.evaluate("secrets", "vault.put"), "metadata");
  assertEquals(policy.evaluate("execution", "model.method.run"), "none");
});

Deno.test("AuditPolicy: empty rules array uses default", () => {
  const policy = new AuditPolicy([]);
  assertEquals(policy.evaluate("auth", "auth.login"), "metadata");
});

Deno.test("DEFAULT_AUDIT_POLICY: management tier defaults to metadata", () => {
  assertEquals(
    DEFAULT_AUDIT_POLICY.evaluate("admin", "audit.query"),
    "metadata",
  );
  assertEquals(
    DEFAULT_AUDIT_POLICY.evaluate("admin", "audit.verify"),
    "metadata",
  );
});

Deno.test("DEFAULT_AUDIT_POLICY: data tier uses default metadata", () => {
  assertEquals(
    DEFAULT_AUDIT_POLICY.evaluate("execution", "model.method.run"),
    "metadata",
  );
  assertEquals(
    DEFAULT_AUDIT_POLICY.evaluate("secrets", "vault.get"),
    "metadata",
  );
});
