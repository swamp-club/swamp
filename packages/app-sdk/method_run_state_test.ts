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
import type { ModelMethodRunView } from "../client/protocol.ts";
import {
  IDLE_METHOD_RUN,
  type MethodRunAction,
  methodRunReducer,
  type MethodRunState,
} from "./method_run_state.ts";

const view = (status: string): ModelMethodRunView => ({
  modelId: "m1",
  modelName: "board",
  modelType: "@kanban/board",
  methodName: "move_ticket",
  status,
  outputId: "o1",
  dataArtifacts: [],
});

function fold(actions: MethodRunAction[]): MethodRunState {
  return actions.reduce(methodRunReducer, IDLE_METHOD_RUN);
}

const BEGIN: MethodRunAction = {
  kind: "begin",
  modelName: "board",
  methodName: "move_ticket",
};

Deno.test("methodRunReducer: a run that succeeds keeps its output and result", () => {
  const state = fold([
    BEGIN,
    {
      kind: "event",
      event: {
        kind: "method_output",
        modelName: "board",
        methodName: "move_ticket",
        stream: "stdout",
        line: "moved",
      },
    },
    { kind: "event", event: { kind: "completed", run: view("succeeded") } },
  ]);
  assertEquals(state.status, "succeeded");
  assertEquals(state.output, ["moved"]);
  assertEquals(state.run?.outputId, "o1");
  assertEquals(state.error, undefined);
});

Deno.test("methodRunReducer: a method that throws is failed, with its message", () => {
  const state = fold([
    BEGIN,
    {
      kind: "event",
      event: {
        kind: "error",
        error: { code: "method_failed", message: "No column nope" },
      },
    },
    { kind: "failed", error: "stream closed" },
  ]);
  assertEquals(state.status, "failed");
  assertEquals(state.error, "No column nope");
});

Deno.test("methodRunReducer: a completed run whose reports failed is failed", () => {
  const state = fold([
    BEGIN,
    { kind: "event", event: { kind: "completed", run: view("failed") } },
  ]);
  assertEquals(state.status, "failed");
});

Deno.test("methodRunReducer: a new run starts clean", () => {
  const state = fold([
    BEGIN,
    { kind: "failed", error: "boom" },
    BEGIN,
  ]);
  assertEquals(state, {
    status: "running",
    modelName: "board",
    methodName: "move_ticket",
    output: [],
  });
});

Deno.test("methodRunReducer: output keeps the newest 500 lines", () => {
  const lines: MethodRunAction[] = Array.from({ length: 510 }, (_, i) => ({
    kind: "event",
    event: {
      kind: "method_output",
      modelName: "board",
      methodName: "move_ticket",
      stream: "stdout",
      line: `l${i}`,
    },
  }));
  const state = fold([BEGIN, ...lines]);
  assertEquals(state.output.length, 500);
  assertEquals(state.output[0], "l10");
});
