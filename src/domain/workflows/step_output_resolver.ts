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
import type { SecretSink } from "../secrets/mod.ts";
import {
  parseSensitiveFieldsTag,
  resolveSensitiveVaultRefs,
} from "../models/data_writer.ts";
import { VaultAccessDeniedError } from "../vaults/run_vault_access.ts";
import { isUnreadableContentError } from "../datastore/unreadable_content.ts";
import type {
  StepOutputGroup,
  StepOutputRecord,
  StepOutputSources,
} from "../expressions/step_output_sources.ts";
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
  /**
   * The namespace the record was written in, when the run record carries it
   * (records written since `fromResourceHandle` set one). Absent on older
   * run records; outputs are own-namespace by construction, so the reader
   * supplies its own then.
   */
  namespace?: string;
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
  /**
   * The stored records the outputs were merged from, in write order, so a
   * typed evaluator can view them through the accessor adapter with each
   * tagged field a Secret (typed-secrets 4.2). Undefined when nothing
   * contributes.
   */
  sources?: StepOutputSources;
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
 * The JSON resource records a model_method step output holds, each with its
 * reference, in the order the step wrote them. Non-JSON resources carry no
 * attributes and are left out, as is a record missing what a reference
 * needs.
 */
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

/**
 * Lists the JSON resources a model_method step output records, in the order
 * the step wrote them. Non-JSON resources carry no attributes and are left out.
 */
export function stepResourceRefs(output: unknown): StepResourceRef[] {
  return jsonResourceRecords(output).map(({ ref }) => ref);
}

/**
 * The stored form of a resource for the accessor adapter: the reference's
 * identity and tags with the attributes as read. A reference from an older
 * run record names no namespace and takes the reader's.
 */
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

/** One group at the step's own outputs, or none when nothing contributes. */
function ownSources(
  records: readonly StepOutputRecord[],
): StepOutputSources | undefined {
  return records.length > 0 ? [{ path: [], records }] : undefined;
}

/**
 * Computes a model_method step's outputs from its full (unstripped) output,
 * whose resource records still carry the attributes loaded when the step ran.
 * Used during a live run so downstream steps need no datastore reads. The
 * sources are the same records as stored; `readerNamespace` stands in for
 * a record that names none.
 */
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
 * Domain service that derives step outputs (`steps.<name>.outputs`) from a
 * persisted StepRun. A model_method step's outputs are the flat merge of the
 * attributes of the JSON resources it wrote; a workflow step's outputs are its
 * child run's model_method step outputs, keyed by child step name, one level
 * deep; a wait_for_signal step's outputs are the payload it received and the
 * signal's receipt. Resources the reader cannot find (ephemeral lifetime, collected
 * versions, an uncached remote datastore) or the policy rejects contribute
 * nothing. Each resolution also lists its sources, the records as read, so
 * a typed evaluator can adapt them (typed-secrets 4.2).
 */
export class StepOutputResolver {
  private readonly readAttributes: ResourceAttributeReader;
  private readonly findChildRun?: ChildRunFinder;
  private readonly canRead?: ResourceReadPolicy;
  private readonly namespace: string;

  constructor(deps: {
    readAttributes: ResourceAttributeReader;
    findChildRun?: ChildRunFinder;
    canRead?: ResourceReadPolicy;
    /**
     * The reader's namespace, given to a source whose reference names none
     * (an older run record). Outputs are own-namespace by construction.
     */
    namespace?: string;
  }) {
    this.readAttributes = deps.readAttributes;
    this.findChildRun = deps.findChildRun;
    this.canRead = deps.canRead;
    this.namespace = deps.namespace ?? "";
  }

  /** Resolves the outputs of one step from its persisted output. */
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
   * Resolves a child run's outputs for its parent workflow step: each
   * succeeded model_method step's outputs keyed by step name, with each
   * child step's sources grouped under its name. A step name is unique
   * within a job only: a later job's step of the same name replaces the
   * earlier one's outputs and sources alike. Nested workflow steps inside
   * the child are not followed.
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
      if (this.canRead && !(await this.canRead(ref))) continue;
      let attributes: Record<string, unknown> | undefined;
      try {
        attributes = await this.readAttributes(ref);
      } catch (error) {
        // A record the v3 datastore could not materialise fails the read
        // with its code (swamp-club#3617); other unreadable data contributes
        // nothing, like missing data.
        if (isUnreadableContentError(error)) throw error;
        continue;
      }
      if (!attributes) continue;
      attributeSets.push(attributes);
      records.push(outputRecordOf(ref, attributes, this.namespace));
      if (ref.dataId) attributesByDataId[ref.dataId] = attributes;
    }
    return {
      outputs: mergeStepOutputs(attributeSets),
      attributesByDataId,
      sources: ownSources(records),
    };
  }
}

/**
 * Builds a reader over a data repository. When `getVaultService` is given,
 * the resource's sensitive fields are resolved from their vault references,
 * matching what `data.latest` exposes to CEL, and every resolved value is
 * recorded in the run's `sensitiveValues`; without it they stay as stored,
 * which is what a display path such as workflow history needs.
 */
export function createDataRepositoryAttributeReader(
  dataRepo: UnifiedDataRepository,
  options: {
    getVaultService: () => Promise<VaultService>;
    sensitiveValues: SecretSink;
  } | { getVaultService?: undefined } = {},
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
            options.sensitiveValues,
          );
        } catch (error) {
          // A refusal by the run's vault access fails the read like every
          // other vault path (swamp-club#2676); it is never mistaken for an
          // unavailable vault.
          if (error instanceof VaultAccessDeniedError) throw error;
          // Vault unavailable — leave refs unresolved
        }
      }
    }
    return parsed;
  };
}
