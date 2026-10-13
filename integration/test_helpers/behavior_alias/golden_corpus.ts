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

/**
 * The golden corpus for the behavior-spelling compatibility test
 * (swamp-club#3334): the model-spelled workflow fixtures and the functions that
 * turn them, and `swamp workflow schema`, into the JSON the goldens pin.
 */

import { parse as parseYaml, stringify as stringifyYaml } from "@std/yaml";
import { dirname, fromFileUrl, join } from "@std/path";
import { Workflow } from "../../../src/domain/workflows/workflow.ts";
import { createLibSwampContext } from "../../../src/libswamp/context.ts";
import { collect } from "../../../src/libswamp/testing.ts";
import {
  workflowSchema,
  type WorkflowSchemaData,
  type WorkflowSchemaEvent,
} from "../../../src/libswamp/workflows/schema.ts";

const HERE = dirname(fromFileUrl(import.meta.url));

/** The directory of model-spelled workflow fixtures. */
export const WORKFLOW_FIXTURE_DIR = join(HERE, "workflows");

/** The golden of every fixture's normalised `toData()`. */
export const WORKFLOW_GOLDEN_PATH = join(HERE, "goldens", "workflows.json");

/** The golden of `swamp workflow schema`. */
export const SCHEMA_GOLDEN_PATH = join(HERE, "goldens", "schema.json");

/** The fixture file names, sorted. */
export async function fixtureNames(): Promise<string[]> {
  const names: string[] = [];
  for await (const entry of Deno.readDir(WORKFLOW_FIXTURE_DIR)) {
    if (entry.isFile && entry.name.endsWith(".yaml")) names.push(entry.name);
  }
  return names.sort();
}

/** Reads one fixture's raw YAML text. */
export function readFixture(name: string): Promise<string> {
  return Deno.readTextFile(join(WORKFLOW_FIXTURE_DIR, name));
}

/** The normalised `Workflow.fromData(...).toData()` of a workflow's YAML. */
export function normalisedWorkflow(yaml: string): unknown {
  return Workflow.fromData(parseYaml(yaml) as never).toData();
}

/** Every fixture's normalised `toData()`, keyed by file name. */
export async function workflowGoldenData(): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const name of await fixtureNames()) {
    out[name] = normalisedWorkflow(await readFixture(name));
  }
  return out;
}

/** The data `swamp workflow schema` prints, from libswamp in-process. */
export async function workflowSchemaData(): Promise<WorkflowSchemaData> {
  const events = await collect<WorkflowSchemaEvent>(
    workflowSchema(createLibSwampContext()),
  );
  const done = events.find((e) => e.kind === "completed");
  if (!done || done.kind !== "completed") {
    throw new Error("workflowSchema did not complete");
  }
  return done.data;
}

/** Whether a JSON Schema node is the step-task variant for `type: <tag>`. */
export function isTaskVariant(node: unknown, tag: string): boolean {
  if (!node || typeof node !== "object") return false;
  const props = (node as { properties?: Record<string, unknown> }).properties;
  const type = props?.type as { const?: unknown } | undefined;
  return type?.const === tag;
}

/**
 * A copy of a JSON Schema with every `type: behavior` step-task variant
 * removed from its `oneOf`/`anyOf` lists — what the schema was before the
 * behavior spelling was added.
 */
export function withoutBehaviorVariants(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(withoutBehaviorVariants);
  if (!node || typeof node !== "object") return node;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if ((key === "oneOf" || key === "anyOf") && Array.isArray(value)) {
      out[key] = value.filter((v) => !isTaskVariant(v, "behavior")).map(
        withoutBehaviorVariants,
      );
    } else {
      out[key] = withoutBehaviorVariants(value);
    }
  }
  return out;
}

/** JSON text as the goldens store it. */
export function goldenText(value: unknown): string {
  return JSON.stringify(value, null, 2) + "\n";
}

const BEHAVIOR_FIELD: Readonly<Record<string, string>> = {
  modelIdOrName: "behavior",
  modelType: "behaviorType",
  modelName: "behaviorName",
};

/**
 * A model-spelled workflow's YAML with every `model_method` step task
 * re-spelled in the behavior form, keys kept in place, and how many tasks
 * were re-spelled.
 */
export function respellAsBehavior(
  yaml: string,
): { yaml: string; respelled: number } {
  const data = parseYaml(yaml) as {
    jobs?: { steps?: { task?: Record<string, unknown> }[] }[];
  };
  let respelled = 0;
  for (const job of data.jobs ?? []) {
    for (const step of job.steps ?? []) {
      const task = step.task;
      if (!task || task.type !== "model_method") continue;
      step.task = Object.fromEntries(
        Object.entries(task).map(([key, value]) =>
          key === "type"
            ? [key, "behavior"]
            : [BEHAVIOR_FIELD[key] ?? key, value]
        ),
      );
      respelled++;
    }
  }
  return {
    yaml: stringifyYaml(data as Record<string, unknown>),
    respelled,
  };
}

/** A workflow's YAML as swamp writes it back after loading it. */
export function writtenWorkflow(yaml: string): string {
  return stringifyYaml(
    JSON.parse(JSON.stringify(normalisedWorkflow(yaml))) as Record<
      string,
      unknown
    >,
  );
}
