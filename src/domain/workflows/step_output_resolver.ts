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

import type { UnifiedDataRepository } from "../data/repositories.ts";
import { currentDiagnosticTally } from "../diagnostics/diagnostic_phase.ts";

import { isUnreadableContentError } from "../datastore/unreadable_content.ts";
import type {
  StepOutputGroup,
  StepOutputRecord,
  StepOutputSources,
} from "../expressions/step_output_sources.ts";
import type { StepRun, WorkflowRun } from "./workflow_run.ts";

/**
 * the run record keeps these references but never the attributes, so outputs
 * are read back from the datastore through them
 */
export interface StepResourceRef {
  dataId: string;
  name: string;
  version: number;
  modelType: string;
  modelId: string;
  modelName: string;
  specName: string;
  contentType: string;
  tags: Record<string, string>;
  /**
   * absent on older run records; outputs are own-namespace by construction, so
   * the reader supplies its own
   */
  namespace?: string;
}

export type ResourceAttributeReader = (
  ref: StepResourceRef,
) => Promise<Record<string, unknown> | undefined>;

export type ChildRunFinder = (
  workflowId: string,
  runId: string,
) => Promise<WorkflowRun | null>;

export type ResourceReadPolicy = (ref: StepResourceRef) => Promise<boolean>;

export interface ResolvedStepOutputs {
  outputs?: Record<string, unknown>;
  attributesByDataId: Record<string, Record<string, unknown>>;
  sources?: StepOutputSources;
}

const JSON_CONTENT_TYPE = "application/json";

/**
 * a later resource wins when two share an attribute name; undefined when
 * nothing contributes
 */
export function mergeStepOutputs(
  attributeSets: ReadonlyArray<Record<string, unknown>>,
): Record<string, unknown> | undefined {
  const merged: Record<string, unknown> = {};
  for (const attributes of attributeSets) {
    Object.assign(merged, attributes);
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonResourceRecords(
  output: unknown,
): { ref: StepResourceRef; record: Record<string, unknown> }[] {
  if (!isRecord(output) || output.type !== "model_method") return [];
  if (!isRecord(output.resources)) return [];
  const found: { ref: StepResourceRef; record: Record<string, unknown> }[] = [];
  for (const instances of Object.values(output.resources)) {
    if (!isRecord(instances)) continue;
    for (const record of Object.values(instances)) {
      if (!isRecord(record)) continue;
      if (record.contentType !== JSON_CONTENT_TYPE) continue;
      if (
        typeof record.name !== "string" ||
        typeof record.modelType !== "string" ||
        typeof record.modelId !== "string" ||
        typeof record.version !== "number"
      ) {
        continue;
      }
      found.push({
        ref: {
          dataId: typeof record.id === "string" ? record.id : "",
          name: record.name,
          version: record.version,
          modelType: record.modelType,
          modelId: record.modelId,
          modelName: typeof record.modelName === "string"
            ? record.modelName
            : "",
          specName: typeof record.specName === "string" ? record.specName : "",
          contentType: record.contentType,
          tags: isRecord(record.tags)
            ? record.tags as Record<string, string>
            : {},
          ...(typeof record.namespace === "string"
            ? { namespace: record.namespace }
            : {}),
        },
        record,
      });
    }
  }
  return found;
}

export function stepResourceRefs(output: unknown): StepResourceRef[] {
  return jsonResourceRecords(output).map(({ ref }) => ref);
}

function outputRecordOf(
  ref: StepResourceRef,
  attributes: Record<string, unknown>,
  readerNamespace: string,
): StepOutputRecord {
  return {
    id: ref.dataId,
    name: ref.name,
    version: ref.version,
    namespace: ref.namespace ?? readerNamespace,
    modelName: ref.modelName,
    tags: ref.tags,
    attributes,
  };
}

function ownSources(
  records: readonly StepOutputRecord[],
): StepOutputSources | undefined {
  return records.length > 0 ? [{ path: [], records }] : undefined;
}

export function liveStepOutputs(
  output: unknown,
  readerNamespace = "",
): Pick<ResolvedStepOutputs, "outputs" | "sources"> {
  const attributeSets: Record<string, unknown>[] = [];
  const records: StepOutputRecord[] = [];
  for (const { ref, record } of jsonResourceRecords(output)) {
    if (!isRecord(record.attributes)) continue;
    attributeSets.push(record.attributes);
    records.push(outputRecordOf(ref, record.attributes, readerNamespace));
  }
  return {
    outputs: mergeStepOutputs(attributeSets),
    sources: ownSources(records),
  };
}

/**
 * resources the reader cannot find (ephemeral, collected, uncached remote) or
 * the policy rejects contribute nothing
 */
export class StepOutputResolver {
  private readonly readAttributes: ResourceAttributeReader;
  private readonly findChildRun?: ChildRunFinder;
  private readonly canRead?: ResourceReadPolicy;
  private readonly namespace: string;
  private readonly signal?: AbortSignal;

  constructor(deps: {
    readAttributes: ResourceAttributeReader;
    findChildRun?: ChildRunFinder;
    canRead?: ResourceReadPolicy;
    namespace?: string;
    signal?: AbortSignal;
  }) {
    this.readAttributes = deps.readAttributes;
    this.findChildRun = deps.findChildRun;
    this.canRead = deps.canRead;
    this.namespace = deps.namespace ?? "";
    this.signal = deps.signal;
  }

  async resolve(stepRun: StepRun): Promise<ResolvedStepOutputs> {
    const output = stepRun.output;
    if (!isRecord(output)) return { attributesByDataId: {} };
    if (output.type === "model_method") {
      return await this.resolveResources(output);
    }
    if (output.type === "wait_for_signal") {
      // The payload and receipt are stored on the step itself.
      return {
        outputs: { payload: output.payload, signal: output.signal },
        attributesByDataId: {},
      };
    }
    if (output.type === "workflow") {
      const workflowId = output.workflowId;
      const runId = output.runId;
      if (
        !this.findChildRun || typeof workflowId !== "string" ||
        typeof runId !== "string"
      ) {
        return { attributesByDataId: {} };
      }
      this.signal?.throwIfAborted();
      const childRun = await this.findChildRun(workflowId, runId);
      if (!childRun) return { attributesByDataId: {} };
      const child = await this.resolveChildOutputs(childRun);
      return {
        outputs: child.outputs,
        sources: child.sources,
        attributesByDataId: {},
      };
    }
    return { attributesByDataId: {} };
  }

  /**
   * a step name is unique within a job only, so a later job's step of the same
   * name replaces the earlier one's outputs and sources; nested workflow steps
   * in the child are not followed
   */
  async resolveChildOutputs(
    childRun: WorkflowRun,
  ): Promise<Pick<ResolvedStepOutputs, "outputs" | "sources">> {
    const outputs: Record<string, unknown> = {};
    const sourcesByStep = new Map<string, StepOutputGroup[]>();
    for (const job of childRun.jobs) {
      for (const step of job.steps) {
        if (step.status !== "succeeded") continue;
        const resolved = await this.resolveResources(step.output);
        if (!resolved.outputs) continue;
        // An own key: a step may be named __proto__.
        Object.defineProperty(outputs, step.stepName, {
          value: resolved.outputs,
          writable: true,
          enumerable: true,
          configurable: true,
        });
        sourcesByStep.set(
          step.stepName,
          (resolved.sources ?? []).map((group) => ({
            path: [step.stepName, ...group.path],
            records: group.records,
          })),
        );
      }
    }
    const sources = [...sourcesByStep.values()].flat();
    return {
      outputs: Object.keys(outputs).length > 0 ? outputs : undefined,
      sources: sources.length > 0 ? sources : undefined,
    };
  }

  private async resolveResources(
    output: unknown,
  ): Promise<ResolvedStepOutputs> {
    const attributesByDataId: Record<string, Record<string, unknown>> = {};
    const attributeSets: Record<string, unknown>[] = [];
    const records: StepOutputRecord[] = [];
    for (const ref of stepResourceRefs(output)) {
      this.signal?.throwIfAborted();
      if (this.canRead && !(await this.canRead(ref))) continue;
      this.signal?.throwIfAborted();
      let attributes: Record<string, unknown> | undefined;
      try {
        attributes = await this.readAttributes(ref);
      } catch (error) {
        // a record the v3 datastore could not materialise fails the read with
        // its code; other unreadable data contributes nothing, like missing
        // data
        if (isUnreadableContentError(error)) throw error;
        continue;
      }
      if (!attributes) continue;
      attributeSets.push(attributes);
      records.push(outputRecordOf(ref, attributes, this.namespace));
      if (ref.dataId) attributesByDataId[ref.dataId] = attributes;
    }
    return currentDiagnosticTally().measureSync("assemble", () => ({
      outputs: mergeStepOutputs(attributeSets),
      attributesByDataId,
      sources: ownSources(records),
    }));
  }
}

/**
 * without getVaultService sensitive fields stay as stored, which is what a
 * display path such as workflow history needs
 */
export function createDataRepositoryAttributeReader(
  dataRepo: UnifiedDataRepository,
): ResourceAttributeReader {
  return async (ref) => {
    const tally = currentDiagnosticTally();
    let content: Uint8Array | null;
    try {
      content = await tally.measure("content_read", () =>
        dataRepo.getContent(
          ref.modelType,
          ref.modelId,
          ref.name,
          ref.version,
        ));
    } catch (error) {
      tally.add("reads_failed");
      throw error;
    }
    if (!content) {
      tally.add("reads_missing");
      return undefined;
    }
    tally.add("reads_succeeded");
    tally.add("content_bytes", content.length);
    let parsed: unknown;
    try {
      parsed = tally.measureSync(
        "json_parse",
        () => JSON.parse(new TextDecoder().decode(content)),
      );
    } catch {
      tally.add("parse_failed");
      return undefined;
    }
    if (!isRecord(parsed)) {
      tally.add("parse_not_object");
      return undefined;
    }
    return parsed;
  };
}
