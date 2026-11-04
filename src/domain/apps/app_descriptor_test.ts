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

import { assertEquals, assertThrows } from "@std/assert";
import { UserError } from "../errors.ts";
import {
  appCollective,
  appFolderName,
  capabilityKey,
  parseAppDescriptor,
} from "./app_descriptor.ts";

const VALID = `
name: "@acme/cost"
title: Cost
bridge: 1
capabilities: [runs:read]
run: ["@acme/nightly"]
`;

Deno.test("parseAppDescriptor: reads a descriptor and defaults its entry", () => {
  const descriptor = parseAppDescriptor(VALID, "app.yaml");
  assertEquals(descriptor.name, "@acme/cost");
  assertEquals(descriptor.entry, "dist/index.html");
  assertEquals(descriptor.capabilities, ["runs:read"]);
  assertEquals(descriptor.run, ["@acme/nightly"]);
});

Deno.test("parseAppDescriptor: refuses an unknown capability", () => {
  assertThrows(
    () => parseAppDescriptor(`${VALID}\nextra: 1`, "app.yaml"),
    UserError,
  );
  assertThrows(
    () =>
      parseAppDescriptor(
        VALID.replace("runs:read", "vault:read"),
        "app.yaml",
      ),
    UserError,
    "Unknown capability",
  );
});

Deno.test("parseAppDescriptor: refuses an entry outside the app", () => {
  for (
    const entry of [
      "../secret.html",
      "/etc/passwd",
      "a/../../b.html",
      "index.html",
      "./index.html",
      "dist//index.html",
    ]
  ) {
    assertThrows(
      () => parseAppDescriptor(`${VALID}\nentry: ${entry}`, "app.yaml"),
      UserError,
      "entry",
    );
  }
});

Deno.test("parseAppDescriptor: refuses a behavior listed under methods twice", () => {
  assertThrows(
    () =>
      parseAppDescriptor(
        `${VALID}methods:
  - behavior: deploy
    type: "@acme/report"
    methods: [run]
  - model: deploy
    type: command/shell
    methods: [run]
`,
        "app.yaml",
      ),
    UserError,
    "more than once",
  );
});

Deno.test("parseAppDescriptor: reads each behavior with the methods it may run", () => {
  const descriptor = parseAppDescriptor(
    `${VALID}methods:
  - behavior: team-board
    type: "@acme/board"
    methods: [move_ticket, add_ticket]
  - model: plan
    type: "@acme/plan"
    methods: [setMeta]
`,
    "app.yaml",
  );
  assertEquals(descriptor.methods, [
    {
      behavior: "team-board",
      type: "@acme/board",
      methods: ["move_ticket", "add_ticket"],
    },
    { behavior: "plan", type: "@acme/plan", methods: ["setMeta"] },
  ]);
});

Deno.test("parseAppDescriptor: refuses a behavior entry with no method list", () => {
  for (const methods of ["", "\n    methods: []"]) {
    assertThrows(
      () =>
        parseAppDescriptor(
          `${VALID}methods:
  - model: plan
    type: "@acme/plan"${methods}
`,
          "app.yaml",
        ),
      UserError,
      "methods.0.methods: each entry lists the methods the app may run",
    );
  }
});

Deno.test("parseAppDescriptor: refuses a method listed twice", () => {
  assertThrows(
    () =>
      parseAppDescriptor(
        `${VALID}methods:
  - behavior: plan
    type: "@acme/plan"
    methods: [a, a]
`,
        "app.yaml",
      ),
    UserError,
    "lists a method more than once",
  );
});

Deno.test("parseAppDescriptor: refuses an entry naming both behavior and model", () => {
  assertThrows(
    () =>
      parseAppDescriptor(
        `${VALID}methods:
  - behavior: plan
    model: plan
    type: "@acme/plan"
    methods: [a]
`,
        "app.yaml",
      ),
    UserError,
    "not both",
  );
});

Deno.test("parseAppDescriptor: refuses an entry naming no behavior", () => {
  assertThrows(
    () =>
      parseAppDescriptor(
        `${VALID}methods:
  - type: "@acme/plan"
    methods: [a]
`,
        "app.yaml",
      ),
    UserError,
    "behavior:",
  );
});

Deno.test("parseAppDescriptor: refuses a name with no collective", () => {
  assertThrows(
    () => parseAppDescriptor(VALID.replace("@acme/cost", "cost"), "app.yaml"),
    UserError,
  );
});

Deno.test("parseAppDescriptor: refuses a bridge this swamp does not speak", () => {
  assertThrows(
    () =>
      parseAppDescriptor(VALID.replace("bridge: 1", "bridge: 2"), "app.yaml"),
    UserError,
  );
});

Deno.test("appCollective: drops the @ and the rest of the name", () => {
  assertEquals(appCollective("@acme/tools/cost"), "acme");
});

Deno.test("capabilityKey: a new capability changes the key", () => {
  assertEquals(
    capabilityKey({ capabilities: ["runs:read"], run: [] }, "local") ===
      capabilityKey(
        { capabilities: ["runs:read", "data:read"], run: [] },
        "local",
      ),
    false,
  );
});

Deno.test("capabilityKey: a capability is not a workflow of the same name", () => {
  assertEquals(
    capabilityKey({ capabilities: ["a"], run: [] }, "local") ===
      capabilityKey({ capabilities: [], run: ["a"] }, "local"),
    false,
  );
});

Deno.test("capabilityKey: the same grant from another origin is a new key", () => {
  const grant = { capabilities: ["runs:read"], run: [] };
  assertEquals(
    capabilityKey(grant, "local") === capabilityKey(grant, "extension"),
    false,
  );
});

const grantOf = (behavior: string, type: string, methods: string[]) => ({
  capabilities: [],
  run: [],
  methods: [{ behavior, type, methods }],
});

Deno.test("capabilityKey: a space cannot move the behavior and type boundary", () => {
  assertEquals(
    capabilityKey(grantOf("a", "b c", ["m"]), "local") ===
      capabilityKey(grantOf("a b", "c", ["m"]), "local"),
    false,
  );
});

Deno.test("capabilityKey: a changed method list sends the app back for review", () => {
  const before = capabilityKey(grantOf("board", "@a/board", ["tick"]), "local");
  assertEquals(
    before ===
      capabilityKey(grantOf("board", "@a/board", ["tick", "delete"]), "local"),
    false,
  );
  assertEquals(
    before === capabilityKey(grantOf("board", "@a/board", ["delete"]), "local"),
    false,
  );
});

Deno.test("capabilityKey: reordering the method list keeps the key", () => {
  assertEquals(
    capabilityKey(grantOf("board", "@a/board", ["a", "b"]), "local"),
    capabilityKey(grantOf("board", "@a/board", ["b", "a"]), "local"),
  );
});

Deno.test("appFolderName: takes the last segment of the name", () => {
  assertEquals(appFolderName("@acme/cost"), "cost");
  assertEquals(appFolderName("@acme/tools/cost"), "cost");
});
