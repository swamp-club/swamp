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

import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { stripAnsiCode } from "@std/fmt/colors";
import { consumeStream } from "../../libswamp/mod.ts";
import type { ModelValidateEvent } from "../../libswamp/mod.ts";
import { createModelValidateRenderer } from "./model_validate.ts";
import { UserError } from "../../domain/errors.ts";

async function* toStream(
  events: ModelValidateEvent[],
): AsyncGenerator<ModelValidateEvent> {
  for (const event of events) {
    yield event;
  }
}

Deno.test("JsonModelValidateRenderer - single model outputs JSON", async () => {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);

  try {
    const renderer = createModelValidateRenderer("json");
    await consumeStream(
      toStream([
        { kind: "resolving" },
        {
          kind: "completed",
          data: {
            modelId: "def-1",
            modelName: "my-model",
            type: "aws/ec2",
            validations: [{ name: "schema", passed: true }],
            warnings: [],
            passed: true,
          },
        },
      ]),
      renderer.handlers(),
    );
    assertEquals(logs.length, 1);
    assertEquals(renderer.passed(), true);
    const parsed = JSON.parse(logs[0]);
    assertEquals(parsed.passed, true);
  } finally {
    console.log = originalLog;
  }
});

Deno.test("ModelValidateRenderer - tracks failed state", async () => {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);

  try {
    const renderer = createModelValidateRenderer("json");
    await consumeStream(
      toStream([
        { kind: "resolving" },
        {
          kind: "completed",
          data: {
            modelId: "def-1",
            modelName: "my-model",
            type: "aws/ec2",
            validations: [
              { name: "schema", passed: false, error: "invalid" },
            ],
            warnings: [],
            passed: false,
          },
        },
      ]),
      renderer.handlers(),
    );
    assertEquals(renderer.passed(), false);
  } finally {
    console.log = originalLog;
  }
});

Deno.test("ModelValidateRenderer - error throws UserError", () => {
  const renderer = createModelValidateRenderer("log");
  const handlers = renderer.handlers();
  assertThrows(
    () =>
      handlers.error({
        kind: "error",
        error: { code: "test", message: "boom" },
      }),
    UserError,
    "boom",
  );
});

const templateWarningData = {
  modelId: "def-1",
  modelName: "dd-monitor",
  type: "bitbison/datadog-monitor",
  validations: [{ name: "Expression paths", passed: true }],
  warnings: [{
    name: "Template syntax passed through",
    message: "This text is not a swamp expression.",
    templates: [
      { path: "globalArguments.message", text: "{{host.name}}" },
      { path: "methods.execute.arguments.run", text: "${HOME}" },
    ],
  }],
  passed: true,
};

Deno.test("ModelValidateRenderer - log mode lists template syntax passed through", async () => {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);

  try {
    const renderer = createModelValidateRenderer("log");
    await consumeStream(
      toStream([{ kind: "completed", data: templateWarningData }]),
      renderer.handlers(),
    );
    const combined = stripAnsiCode(logs.join("\n"));
    assertStringIncludes(combined, "Template syntax passed through");
    assertStringIncludes(
      combined,
      "    globalArguments.message passes {{host.name}}",
    );
    assertStringIncludes(
      combined,
      "    methods.execute.arguments.run passes ${HOME}",
    );
    assertEquals(renderer.passed(), true);
  } finally {
    console.log = originalLog;
  }
});

Deno.test("JsonModelValidateRenderer - includes the templates of a template syntax warning", async () => {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);

  try {
    const renderer = createModelValidateRenderer("json");
    await consumeStream(
      toStream([{ kind: "completed", data: templateWarningData }]),
      renderer.handlers(),
    );
    const parsed = JSON.parse(logs[0]);
    assertEquals(parsed.warnings[0].name, "Template syntax passed through");
    assertEquals(parsed.warnings[0].templates, [
      { path: "globalArguments.message", text: "{{host.name}}" },
      { path: "methods.execute.arguments.run", text: "${HOME}" },
    ]);
    assertEquals(parsed.passed, true);
  } finally {
    console.log = originalLog;
  }
});
