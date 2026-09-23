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
import type { VaultService } from "../vaults/vault_service.ts";
import type { SecretRedactor } from "../secrets/mod.ts";
import {
  parseSensitiveFieldsTag,
  resolveSensitiveVaultRefs,
} from "../models/data_writer.ts";
import type { StepRun, WorkflowRun } from "./workflow_run.ts";

/**
 * A resource a model_method step wrote, as recorded on the step's persisted
 * output. The run record keeps these references but never the attributes
 * (see stripResourceContent in execution_service.ts, swamp-club#1673), so
 * step outputs are read back from the datastore through these references.
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
}

/** Reads a resource's attributes, or undefined when they are unavailable. */
export type ResourceAttributeReader = (
  ref: StepResourceRef,
) => Promise<Record<string, unknown> | undefined>;

/** Finds a child workflow run recorded on a parent workflow step. */
export type ChildRunFinder = (
  workflowId: string,
  runId: string,
) => Promise<WorkflowRun | null>;

/** Decides whether a resource's attributes may appear in resolved outputs. */
export type ResourceReadPolicy = (ref: StepResourceRef) => Promise<boolean>;

/** A step's outputs plus the attributes of each resource they came from. */
export interface ResolvedStepOutputs {
  /** Flat merge of the step's JSON resource attributes; undefined if none. */
  outputs?: Record<string, unknown>;
  /** Attributes of each contributing resource, keyed by its dataId. */
  attributesByDataId: Record<string, Record<string, unknown>>;
}

const JSON_CONTENT_TYPE = "application/json";

/**
 * Merges resource attributes into one flat outputs record, in order. A later
 * resource wins when two share an attribute name. Returns undefined when
 * nothing contributes, so a step with no attributes has no outputs.
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

/**
 * Lists the JSON resources a model_method step output records, in the order
 * the step wrote them. Non-JSON resources carry no attributes and are left out.
 */
export function stepResourceRefs(output: unknown): StepResourceRef[] {
  if (!isRecord(output) || output.type !== "model_method") return [];
  if (!isRecord(output.resources)) return [];
  const refs: StepResourceRef[] = [];
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
      refs.push({
        dataId: typeof record.id === "string" ? record.id : "",
        name: record.name,
        version: record.version,
        modelType: record.modelType,
        modelId: record.modelId,
        modelName: typeof record.modelName === "string" ? record.modelName : "",
        specName: typeof record.specName === "string" ? record.specName : "",
        contentType: record.contentType,
        tags: isRecord(record.tags)
          ? record.tags as Record<string, string>
          : {},
      });
    }
  }
  return refs;
}

/**
 * Computes a model_method step's outputs from its full (unstripped) output,
 * whose resource records still carry the attributes loaded when the step ran.
 * Used during a live run so downstream steps need no datastore reads.
 */
export function liveStepOutputs(
  output: unknown,
): Record<string, unknown> | undefined {
  if (!isRecord(output) || output.type !== "model_method") return undefined;
  if (!isRecord(output.resources)) return undefined;
  const attributeSets: Record<string, unknown>[] = [];
  for (const instances of Object.values(output.resources)) {
    if (!isRecord(instances)) continue;
    for (const record of Object.values(instances)) {
      if (!isRecord(record) || record.contentType !== JSON_CONTENT_TYPE) {
        continue;
      }
      if (isRecord(record.attributes)) attributeSets.push(record.attributes);
    }
  }
  return mergeStepOutputs(attributeSets);
}

/**
 * Domain service that derives step outputs (`steps.<name>.outputs`) from a
 * persisted StepRun. A model_method step's outputs are the flat merge of the
 * attributes of the JSON resources it wrote; a workflow step's outputs are its
 * child run's model_method step outputs, keyed by child step name, one level
 * deep. Resources the reader cannot find (ephemeral lifetime, collected
 * versions, an uncached remote datastore) or the policy rejects contribute
 * nothing.
 */
export class StepOutputResolver {
  private readonly readAttributes: ResourceAttributeReader;
  private readonly findChildRun?: ChildRunFinder;
  private readonly canRead?: ResourceReadPolicy;

  constructor(deps: {
    readAttributes: ResourceAttributeReader;
    findChildRun?: ChildRunFinder;
    canRead?: ResourceReadPolicy;
  }) {
    this.readAttributes = deps.readAttributes;
    this.findChildRun = deps.findChildRun;
    this.canRead = deps.canRead;
  }

  /** Resolves the outputs of one step from its persisted output. */
  async resolve(stepRun: StepRun): Promise<ResolvedStepOutputs> {
    const output = stepRun.output;
    if (!isRecord(output)) return { attributesByDataId: {} };
    if (output.type === "model_method") {
      return await this.resolveResources(output);
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
      const childRun = await this.findChildRun(workflowId, runId);
      if (!childRun) return { attributesByDataId: {} };
      return {
        outputs: await this.resolveChildOutputs(childRun),
        attributesByDataId: {},
      };
    }
    return { attributesByDataId: {} };
  }

  /**
   * Resolves a child run's outputs for its parent workflow step: each
   * succeeded model_method step's outputs keyed by step name. Nested workflow
   * steps inside the child are not followed.
   */
  async resolveChildOutputs(
    childRun: WorkflowRun,
  ): Promise<Record<string, unknown> | undefined> {
    const outputs: Record<string, unknown> = {};
    for (const job of childRun.jobs) {
      for (const step of job.steps) {
        if (step.status !== "succeeded") continue;
        const { outputs: stepOutputs } = await this.resolveResources(
          step.output,
        );
        if (stepOutputs) outputs[step.stepName] = stepOutputs;
      }
    }
    return Object.keys(outputs).length > 0 ? outputs : undefined;
  }

  private async resolveResources(
    output: unknown,
  ): Promise<ResolvedStepOutputs> {
    const attributesByDataId: Record<string, Record<string, unknown>> = {};
    const attributeSets: Record<string, unknown>[] = [];
    for (const ref of stepResourceRefs(output)) {
      if (this.canRead && !(await this.canRead(ref))) continue;
      let attributes: Record<string, unknown> | undefined;
      try {
        attributes = await this.readAttributes(ref);
      } catch {
        // Unreadable data contributes nothing, like missing data.
        continue;
      }
      if (!attributes) continue;
      attributeSets.push(attributes);
      if (ref.dataId) attributesByDataId[ref.dataId] = attributes;
    }
    return { outputs: mergeStepOutputs(attributeSets), attributesByDataId };
  }
}

/**
 * Builds a reader over a data repository. When `getVaultService` is given,
 * the resource's sensitive fields are resolved from their vault references,
 * matching what `model.<name>.resource` exposes to CEL; without it they stay
 * as stored, which is what a display path such as workflow history needs.
 */
export function createDataRepositoryAttributeReader(
  dataRepo: UnifiedDataRepository,
  options: {
    getVaultService?: () => Promise<VaultService>;
    redactor?: SecretRedactor;
  } = {},
): ResourceAttributeReader {
  return async (ref) => {
    const content = await dataRepo.getContent(
      ref.modelType,
      ref.modelId,
      ref.name,
      ref.version,
    );
    if (!content) return undefined;
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(content));
    } catch {
      return undefined;
    }
    if (!isRecord(parsed)) return undefined;
    if (options.getVaultService && Object.keys(parsed).length > 0) {
      const sensitiveFields = parseSensitiveFieldsTag(ref.tags);
      if (sensitiveFields) {
        try {
          await resolveSensitiveVaultRefs(
            parsed,
            sensitiveFields,
            await options.getVaultService(),
            options.redactor,
          );
        } catch {
          // Vault unavailable — leave refs unresolved
        }
      }
    }
    return parsed;
  };
}
