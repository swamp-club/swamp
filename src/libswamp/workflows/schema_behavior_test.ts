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

// `swamp workflow schema` documents the behavior spelling of a step task
// (swamp-club#3334) beside every model_method variant.

import { assert, assertEquals } from "@std/assert";
import { createLibSwampContext } from "../context.ts";
import { collect } from "../testing.ts";
import { workflowSchema, type WorkflowSchemaEvent } from "./schema.ts";
import { BEHAVIOR_STEP_TASK_FIELDS } from "../../domain/terminology/behavior_aliases.ts";

type Node = Record<string, unknown>;

function variantType(node: unknown): unknown {
  const props = (node as { properties?: Node } | undefined)?.properties;
  return (props?.type as { const?: unknown } | undefined)?.const;
}

/** Every oneOf/anyOf list in `node` that holds a model_method variant. */
function taskLists(node: unknown, out: unknown[][] = []): unknown[][] {
  if (Array.isArray(node)) {
    for (const n of node) taskLists(n, out);
  } else if (node && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) {
      if (
        (key === "oneOf" || key === "anyOf") && Array.isArray(value) &&
        value.some((v) => variantType(v) === "model_method")
      ) out.push(value);
      taskLists(value, out);
    }
  }
  return out;
}

Deno.test("workflowSchema: a behavior variant follows every model_method variant", async () => {
  const events = await collect<WorkflowSchemaEvent>(
    workflowSchema(createLibSwampContext()),
  );
  const done = events[0] as Extract<WorkflowSchemaEvent, { kind: "completed" }>;
  for (const key of ["workflow", "job", "step", "stepTask"] as const) {
    const lists = taskLists(done.data[key]);
    assertEquals(lists.length, 1, key);
    for (const list of lists) {
      const types = list.map(variantType);
      assertEquals(
        types.filter((t) => t === "behavior").length,
        1,
        `${key}: ${types.join(",")}`,
      );
      const at = types.indexOf("model_method");
      assertEquals(types[at + 1], "behavior", key);
      const model = list[at] as Node;
      const behavior = list[at + 1] as Node;
      assert(!("$schema" in behavior), key);
      // Field parity: each behavior field stands for a model_method field.
      const modelProps = Object.keys(model.properties as Node);
      const behaviorProps = Object.keys(behavior.properties as Node);
      assertEquals(
        behaviorProps.map((p) => BEHAVIOR_STEP_TASK_FIELDS[p] ?? p),
        modelProps,
        key,
      );
      assertEquals(behavior.required, model.required, key);
      assertEquals(
        behavior.additionalProperties,
        model.additionalProperties,
        key,
      );
    }
  }
  for (
    const key of [
      "jobDependency",
      "stepDependency",
      "triggerCondition",
    ] as const
  ) {
    assertEquals(taskLists(done.data[key]).length, 0, key);
    assert(!JSON.stringify(done.data[key]).includes('"behavior"'), key);
  }
});
