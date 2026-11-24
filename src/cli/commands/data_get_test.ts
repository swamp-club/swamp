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

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { UserError } from "../../domain/errors.ts";
import { initializeLogging } from "../../infrastructure/logging/logger.ts";

import "../../domain/models/models.ts";

await initializeLogging({});

Deno.test("dataGetCommand module loads", async () => {
  const { dataGetCommand } = await import("./data_get.ts");
  assertEquals(dataGetCommand.getName(), "get");
});

Deno.test("dataGetCommand: description marks it deprecated in favor of data query", async () => {
  const { dataGetCommand } = await import("./data_get.ts");
  const description = dataGetCommand.getDescription();
  assertEquals(description.startsWith("(Deprecated)"), true);
  assertStringIncludes(description, "swamp data query");
});

Deno.test("dataGetCommand: workflow example names the data and reads the latest run without --run", async () => {
  const { dataGetCommand } = await import("./data_get.ts");
  const workflowExamples = dataGetCommand.getExamples().filter((e) =>
    e.description.includes("--workflow")
  );
  assertEquals(workflowExamples.map((e) => e.description), [
    "swamp data get --workflow deploy <data-name>",
  ]);
});

Deno.test("dataGetCommand is registered as subcommand of dataCommand", async () => {
  const { createDataCommand } = await import("./data.ts");
  const dataCommand = await createDataCommand();
  const commands = dataCommand.getCommands();
  const getCmd = commands.find((c) => c.getName() === "get");
  assertEquals(getCmd !== undefined, true);
});

Deno.test("dataGetCommand has --workflow option", async () => {
  const { dataGetCommand } = await import("./data_get.ts");
  const options = dataGetCommand.getOptions();
  const workflowOpt = options.find((o) => o.name === "workflow");
  assertEquals(workflowOpt !== undefined, true);
});

Deno.test("dataGetCommand has --run option", async () => {
  const { dataGetCommand } = await import("./data_get.ts");
  const options = dataGetCommand.getOptions();
  const runOpt = options.find((o) => o.name === "run");
  assertEquals(runOpt !== undefined, true);
});

Deno.test("dataGetCommand accepts optional model argument", async () => {
  const { dataGetCommand } = await import("./data_get.ts");
  const args = dataGetCommand.getArguments();
  assertEquals(args.length > 0, true);
});

Deno.test("dataGetCommand has --no-content option", async () => {
  const { dataGetCommand } = await import("./data_get.ts");
  const options = dataGetCommand.getOptions();
  const contentOpt = options.find((o) => o.name === "no-content");
  assertEquals(contentOpt !== undefined, true);
});

Deno.test("dataGetCommand has --behavior option with its --model alias", async () => {
  const { dataGetCommand } = await import("./data_get.ts");
  const options = dataGetCommand.getOptions();
  const modelOpt = options.find((o) => o.name === "behavior");
  assertEquals(modelOpt?.flags, ["--behavior", "--model"]);
});

Deno.test("dataGetCommand has --name option", async () => {
  const { dataGetCommand } = await import("./data_get.ts");
  const options = dataGetCommand.getOptions();
  const nameOpt = options.find((o) => o.name === "name");
  assertEquals(nameOpt !== undefined, true);
});

function serveAnswering(
  frames: (id: string) => Record<string, unknown>[],
): {
  server: string;
  remoteIndicator: false;
  fetch: typeof fetch;
  sent: unknown[];
} {
  const sent: unknown[] = [];
  return {
    server: "ws://serve.test:9090",
    remoteIndicator: false,
    sent,
    fetch: ((_input: string | URL | Request, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body));
      sent.push(request.payload);
      return Promise.resolve(
        new Response(
          frames(request.id).map((f) => JSON.stringify(f) + "\n").join(""),
          { status: 200, headers: { "content-type": "application/x-ndjson" } },
        ),
      );
    }) as typeof fetch,
  };
}

const record = {
  name: "main",
  version: 1,
  content: "",
  contentEncoding: "utf-8",
  contentType: "application/json",
};

Deno.test("requestRemoteDataGet: asks for parts and puts the content back in its place", async () => {
  const { requestRemoteDataGet } = await import("./data_get.ts");
  const serve = serveAnswering((id) => [
    { type: "data.get.part", id, payload: { content: '{"a":' } },
    { type: "data.get.part", id, payload: { content: "1}" } },
    {
      type: "data.get",
      id,
      payload: { data: record, contentParts: 2, contentLength: 7 },
    },
  ]);
  const data = await requestRemoteDataGet(serve, {
    modelIdOrName: "m",
    dataName: "main",
  });
  assertEquals(serve.sent, [{
    modelIdOrName: "m",
    dataName: "main",
    inParts: true,
  }]);
  assertEquals(
    JSON.stringify(data),
    JSON.stringify({ ...record, content: '{"a":1}' }),
  );
});

Deno.test("requestRemoteDataGet: a serve that predates parts is read from its single reply", async () => {
  const { requestRemoteDataGet } = await import("./data_get.ts");
  const whole = { ...record, content: '{"a":1}' };
  const data = await requestRemoteDataGet(
    serveAnswering((
      id,
    ) => [{ type: "data.get", id, payload: { data: whole } }]),
    { modelIdOrName: "m", dataName: "main" },
  );
  assertEquals(JSON.stringify(data), JSON.stringify(whole));
});

Deno.test("requestRemoteDataGet: a reply missing parts is refused, never shown short", async () => {
  const { requestRemoteDataGet } = await import("./data_get.ts");
  await assertRejects(
    () =>
      requestRemoteDataGet(
        serveAnswering((id) => [
          { type: "data.get.part", id, payload: { content: '{"a":' } },
          {
            type: "data.get",
            id,
            payload: { data: record, contentParts: 2, contentLength: 7 },
          },
        ]),
        { modelIdOrName: "m", dataName: "main" },
      ),
    UserError,
    "sent 1 of the 2 content parts",
  );
});
