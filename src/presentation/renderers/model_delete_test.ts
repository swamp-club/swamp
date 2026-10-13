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
import { initializeLogging } from "../../infrastructure/logging/logger.ts";
import type { ModelDeleteData } from "../../libswamp/models/delete.ts";
import { createModelDeleteRenderer } from "./model_delete.ts";

await initializeLogging({});

const data: ModelDeleteData = {
  id: "def-1",
  name: "my-server",
  type: "aws-ec2",
  inputPath: "models/my-server.yaml",
  resourceDeleted: false,
  outputsDeleted: 0,
  evaluatedInputDeleted: false,
  dataDeleted: false,
  expiredDataAutoCollected: 0,
};

/** The message part of each LogTape record the console sink prints. */
function captureMessages(fn: () => void): string[] {
  const messages: string[] = [];
  const original = console.info;
  console.info = (...args: unknown[]) => {
    const line = args.map(String).join(" ");
    messages.push(line.slice(line.indexOf(": ") + 2));
  };
  try {
    fn();
  } finally {
    console.info = original;
  }
  return messages;
}

Deno.test("LogModelDeleteRenderer: the legacy surface keeps its exact text", () => {
  const messages = captureMessages(() =>
    createModelDeleteRenderer("log").handlers().completed({
      kind: "completed",
      data,
    })
  );
  assertEquals(messages, ['Deleted model: "my-server" ("aws-ec2")']);
});

Deno.test("LogModelDeleteRenderer: an explicit model surface matches the default", () => {
  const messages = captureMessages(() =>
    createModelDeleteRenderer("log", "model").handlers().completed({
      kind: "completed",
      data,
    })
  );
  assertEquals(messages, ['Deleted model: "my-server" ("aws-ec2")']);
});

Deno.test("LogModelDeleteRenderer: the behavior surface says behavior", () => {
  const messages = captureMessages(() =>
    createModelDeleteRenderer("log", "behavior").handlers().completed({
      kind: "completed",
      data,
    })
  );
  assertEquals(messages, ['Deleted behavior: "my-server" ("aws-ec2")']);
});

Deno.test("JsonModelDeleteRenderer: output does not depend on the surface", () => {
  const capture = (surface: "model" | "behavior") => {
    const lines: string[] = [];
    const original = console.log;
    console.log = (line: string) => lines.push(line);
    try {
      createModelDeleteRenderer("json", surface).handlers().completed({
        kind: "completed",
        data,
      });
    } finally {
      console.log = original;
    }
    return lines;
  };
  assertEquals(capture("behavior"), capture("model"));
});
