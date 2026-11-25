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

import { assertEquals, assertRejects } from "@std/assert";
import { UserError } from "../../domain/errors.ts";
import { initializeLogging } from "../../infrastructure/logging/logger.ts";

await initializeLogging({});

Deno.test("modelOutputDataCommand module loads", async () => {
  const { modelOutputDataCommand } = await import("./model_output_data.ts");
  assertEquals(modelOutputDataCommand.getName(), "data");
});

Deno.test("modelOutputDataCommand has correct description", async () => {
  const { modelOutputDataCommand } = await import("./model_output_data.ts");
  assertEquals(
    modelOutputDataCommand.getDescription(),
    "Show data artifact content for a model output",
  );
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

const summary = {
  outputId: "out-1",
  methodName: "run",
  dataId: "d-1",
  dataName: "state",
  version: 1,
  contentType: "application/json",
  field: null,
  data: null,
};

Deno.test("requestRemoteOutputData: asks for parts and parses the value back into its place", async () => {
  const { requestRemoteOutputData } = await import("./model_output_data.ts");
  const serve = serveAnswering((id) => [
    { type: "model.output.data.part", id, payload: { content: '{"a":[1,' } },
    { type: "model.output.data.part", id, payload: { content: "2]}" } },
    {
      type: "model.output.data",
      id,
      payload: { data: summary, dataParts: 2, dataLength: 11 },
    },
  ]);
  const data = await requestRemoteOutputData(serve, { outputIdArg: "out-1" });
  assertEquals(serve.sent, [{ outputIdArg: "out-1", inParts: true }]);
  assertEquals(
    JSON.stringify(data),
    JSON.stringify({ ...summary, data: { a: [1, 2] } }),
  );
});

Deno.test("requestRemoteOutputData: a serve that predates parts is read from its single reply", async () => {
  const { requestRemoteOutputData } = await import("./model_output_data.ts");
  const whole = { ...summary, data: { a: 1 } };
  const data = await requestRemoteOutputData(
    serveAnswering((id) => [{
      type: "model.output.data",
      id,
      payload: { data: whole },
    }]),
    { outputIdArg: "out-1" },
  );
  assertEquals(JSON.stringify(data), JSON.stringify(whole));
});

Deno.test("requestRemoteOutputData: a reply missing parts is refused, never shown short", async () => {
  const { requestRemoteOutputData } = await import("./model_output_data.ts");
  await assertRejects(
    () =>
      requestRemoteOutputData(
        serveAnswering((id) => [
          { type: "model.output.data.part", id, payload: { content: "{" } },
          {
            type: "model.output.data",
            id,
            payload: { data: summary, dataParts: 2, dataLength: 2 },
          },
        ]),
        { outputIdArg: "out-1" },
      ),
    UserError,
    "sent 1 of the 2 content parts",
  );
});

Deno.test("requestRemoteOutputData: parts that do not join into JSON are refused", async () => {
  const { requestRemoteOutputData } = await import("./model_output_data.ts");
  await assertRejects(
    () =>
      requestRemoteOutputData(
        serveAnswering((id) => [
          { type: "model.output.data.part", id, payload: { content: "{x" } },
          {
            type: "model.output.data",
            id,
            payload: { data: summary, dataParts: 1, dataLength: 2 },
          },
        ]),
        { outputIdArg: "out-1" },
      ),
    UserError,
    "not valid JSON",
  );
});
