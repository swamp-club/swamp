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
 * Typed intents: the domain operation each v3 op performs (swamp-club#3233).
 *
 * An op carries both the path it projects to (a {@link RecordKey}) and the
 * operation it performs. Serve authorises on the intent, never on the path.
 * The partition aggregate reads a removed data version from a `data.delete`
 * or `data.gc` intent; new versions come from `data-version` ops' metadata.
 * Every intent belongs to exactly one partition ({@link intentPartition}).
 *
 * The list covers every write swamp makes to aggregate storage today, from
 * the libswamp use cases and the serve handlers that write outside them.
 * Writes the datastore does not sync (bundles, pulled extension sources, the
 * repo marker, vault secrets, control-plane store keys) have no intent; see
 * "v3 domain model" in `design/enablers/datastores.md`.
 *
 * @module
 */

import { ModelType } from "../models/model_type.ts";
import { normalizeModelTypeName } from "../models/control_plane_types.ts";
import {
  DEFINITION_KINDS,
  type DefinitionKind,
  type PartitionKey,
  partitionOf,
} from "./partition_key.ts";

/** A model, by its normalized type and id. Build it with {@link modelRef}. */
export interface ModelRef {
  /** The ModelType's normalized form, never a raw spelling. */
  readonly type: string;
  readonly id: string;
}

/** A workflow run. */
export interface RunRef {
  readonly workflowId: string;
  readonly runId: string;
}

/** A managed-config definition, by kind and name. */
export interface DefinitionRef {
  readonly kind: DefinitionKind;
  readonly name: string;
}

/** An auto-definition, by id. */
export interface AutoDefinitionRef {
  readonly id: string;
}

/**
 * A model reference from a ModelType: only its normalized form is kept, and
 * the id is lowercased.
 */
export function modelRef(type: ModelType, id: string): ModelRef {
  if (!(type instanceof ModelType)) {
    throw new TypeError("modelRef needs a ModelType");
  }
  return { type: type.normalized, id: id.toLowerCase() };
}

/** Intents on a model partition that name a data name and version. */
type DataIntent =
  | {
    /**
     * `data.append` adds content to a live version in place: its commit
     * re-records that version's metadata (swamp-club#3250).
     */
    readonly kind: "data.save" | "data.append";
    readonly model: ModelRef;
    readonly name: string;
    readonly version: number;
  }
  | {
    readonly kind: "data.delete" | "data.gc";
    readonly model: ModelRef;
    readonly name: string;
    /**
     * The version removed. Absent only for keys that carry no version (the
     * name's latest marker, its directory): a delete of a whole name lists
     * each version it has seen as its own versioned op.
     */
    readonly version?: number;
  }
  | {
    readonly kind: "data.rename";
    readonly model: ModelRef;
    readonly name: string;
    readonly to: string;
  };

/** Intents on a model partition that name an output. */
type OutputIntent = {
  readonly kind: "output.save" | "output.delete";
  readonly model: ModelRef;
  readonly outputId: string;
};

/**
 * Intents on a model partition that need nothing beyond the model. The
 * control-plane ones require the model's type: a grant intent a grant, a
 * group intent a group, and so on ({@link CONTROL_PLANE_INTENT_TYPES}).
 */
type ModelOnlyIntent = {
  readonly kind:
    | "evaluated-definition.save"
    | "evaluated-definition.delete"
    | "grant.create"
    | "grant.revoke"
    | "group.create"
    | "group.update"
    | "token.create"
    | "token.revoke"
    | "token.rotate"
    | "worker-token.create"
    | "worker-token.revoke"
    | "worker.delete";
  readonly model: ModelRef;
};

/** Intents on a workflow run's partition. */
type RunIntent = {
  readonly kind:
    | "run.create"
    | "run.update"
    | "run.delete"
    | "run-snapshot.save"
    | "run-snapshot.delete";
  readonly run: RunRef;
};

/** Intents on a managed-config definition's partition. */
type DefinitionIntent =
  | {
    readonly kind:
      | "definition.create"
      | "definition.edit"
      | "definition.delete"
      | "evaluated-workflow.save"
      | "evaluated-workflow.delete";
    readonly definition: DefinitionRef;
  }
  | {
    /** A rename's write under the new name; `from` is the old name. */
    readonly kind: "definition.rename-to";
    readonly definition: DefinitionRef;
    readonly from: string;
  }
  | {
    /** A rename's removal under the old name; `to` is the new name. */
    readonly kind: "definition.rename-from";
    readonly definition: DefinitionRef;
    readonly to: string;
  };

/**
 * The domain operation an op performs. Each kind belongs to one aggregate:
 * a model (`data.*`, `output.*`, `evaluated-definition.*` and the
 * control-plane kinds), a workflow run (`run.*`, `run-snapshot.*`), a
 * managed-config definition (`definition.*`, `evaluated-workflow.*`), an
 * auto-definition, or the extension lockfile.
 */
export type Intent =
  | DataIntent
  | OutputIntent
  | ModelOnlyIntent
  | RunIntent
  | DefinitionIntent
  | {
    readonly kind: "auto-definition.save" | "auto-definition.delete";
    readonly autoDefinition: AutoDefinitionRef;
  }
  | { readonly kind: "lockfile.write" };

/** Every intent kind. */
export type IntentKind = Intent["kind"];

/**
 * The model type each control-plane intent requires, as
 * `normalizeModelTypeName` gives it (so `@swamp/grant` and `swamp/grant`
 * both qualify).
 */
export const CONTROL_PLANE_INTENT_TYPES: Readonly<
  Partial<Record<IntentKind, string>>
> = {
  "grant.create": "swamp/grant",
  "grant.revoke": "swamp/grant",
  "group.create": "swamp/group",
  "group.update": "swamp/group",
  "token.create": "swamp/server-token",
  "token.revoke": "swamp/server-token",
  "token.rotate": "swamp/server-token",
  "worker-token.create": "swamp/enrollment-token",
  "worker-token.revoke": "swamp/enrollment-token",
  "worker.delete": "swamp/worker",
};

/** The fields each kind carries beyond `kind` and its reference. */
type Shape =
  | "model"
  | "data"
  | "data-opt"
  | "rename"
  | "output"
  | "run"
  | "definition"
  | "rename-to"
  | "rename-from"
  | "auto"
  | "lockfile";

const SHAPES: Readonly<Record<IntentKind, Shape>> = {
  "data.save": "data",
  "data.append": "data",
  "data.delete": "data-opt",
  "data.gc": "data-opt",
  "data.rename": "rename",
  "output.save": "output",
  "output.delete": "output",
  "evaluated-definition.save": "model",
  "evaluated-definition.delete": "model",
  "grant.create": "model",
  "grant.revoke": "model",
  "group.create": "model",
  "group.update": "model",
  "token.create": "model",
  "token.revoke": "model",
  "token.rotate": "model",
  "worker-token.create": "model",
  "worker-token.revoke": "model",
  "worker.delete": "model",
  "run.create": "run",
  "run.update": "run",
  "run.delete": "run",
  "run-snapshot.save": "run",
  "run-snapshot.delete": "run",
  "definition.create": "definition",
  "definition.edit": "definition",
  "definition.delete": "definition",
  "evaluated-workflow.save": "definition",
  "evaluated-workflow.delete": "definition",
  "definition.rename-to": "rename-to",
  "definition.rename-from": "rename-from",
  "auto-definition.save": "auto",
  "auto-definition.delete": "auto",
  "lockfile.write": "lockfile",
};

/** Every intent kind, in a stable order. */
export const INTENT_KINDS: readonly IntentKind[] = Object.keys(
  SHAPES,
) as IntentKind[];

/**
 * The kinds that change a managed-config definition itself. The evaluated
 * workflow a run stages shares the definition's partition but is not the
 * definition (swamp-club#3760).
 */
const DEFINITION_CHANGE_KINDS: ReadonlySet<IntentKind> = new Set<IntentKind>([
  "definition.create",
  "definition.edit",
  "definition.delete",
  "definition.rename-to",
  "definition.rename-from",
]);

/** Whether `intent` creates, edits, deletes or renames a definition. */
export function changesDefinition(intent: Intent): boolean {
  return DEFINITION_CHANGE_KINDS.has(intent.kind);
}

/** The longest name, id or type string an intent accepts. */
const MAX_FIELD_LENGTH = 1024;

/**
 * Checks an intent and returns a canonical copy: exactly the fields its
 * kind carries, in a fixed order, frozen. Throws for an unknown kind, a
 * missing or extra field, a malformed reference (see {@link partitionOf}), a
 * data name that could escape its directory, a version that is not a
 * positive integer, or a control-plane intent on a model of another type.
 */
export function createIntent(value: unknown): Intent {
  const json = asObject(value, "Intent");
  const kind = json.kind;
  if (typeof kind !== "string" || !Object.hasOwn(SHAPES, kind)) {
    throw new Error(`Unknown intent kind: ${String(kind)}`);
  }
  const intentKind = kind as IntentKind;
  const shape = SHAPES[intentKind];
  const intent = build(intentKind, shape, json);
  requireOnlyFields(json, Object.keys(intent), intentKind);
  // Every reference must form a valid partition key.
  intentPartition(intent);
  return deepFreeze(intent);
}

/** The partition an intent's aggregate is stored in. */
export function intentPartition(intent: Intent): PartitionKey {
  if ("model" in intent) {
    return partitionOf({
      kind: "model",
      type: ModelType.create(intent.model.type),
      id: intent.model.id,
    });
  }
  if ("run" in intent) {
    return partitionOf({
      kind: "run",
      workflowId: intent.run.workflowId,
      runId: intent.run.runId,
    });
  }
  if ("definition" in intent) {
    return partitionOf({
      kind: "config",
      definitionKind: intent.definition.kind,
      name: intent.definition.name,
    });
  }
  if ("autoDefinition" in intent) {
    return partitionOf({ kind: "definition", id: intent.autoDefinition.id });
  }
  return partitionOf({ kind: "lockfile" });
}

/** Two intents are equal when their canonical forms are. */
export function intentEquals(a: Intent, b: Intent): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function build(
  kind: IntentKind,
  shape: Shape,
  json: Record<string, unknown>,
): Intent {
  switch (shape) {
    case "model":
      return { kind, model: readModel(json.model, kind) } as Intent;
    case "data":
      return {
        kind,
        model: readModel(json.model, kind),
        name: readDataName(json.name),
        version: readVersion(json.version),
      } as Intent;
    case "data-opt": {
      const model = readModel(json.model, kind);
      const name = readDataName(json.name);
      return (json.version === undefined
        ? { kind, model, name }
        : { kind, model, name, version: readVersion(json.version) }) as Intent;
    }
    case "rename":
      return {
        kind,
        model: readModel(json.model, kind),
        name: readDataName(json.name),
        to: readDataName(json.to),
      } as Intent;
    case "output":
      return {
        kind,
        model: readModel(json.model, kind),
        outputId: readString(json.outputId, "outputId"),
      } as Intent;
    case "run": {
      const run = asObject(json.run, "run");
      requireOnlyFields(run, ["workflowId", "runId"], kind);
      return {
        kind,
        run: {
          workflowId: readId(run.workflowId, "workflowId"),
          runId: readId(run.runId, "runId"),
        },
      } as Intent;
    }
    case "definition":
      return {
        kind,
        definition: readDefinition(json.definition, kind),
      } as Intent;
    case "rename-to":
      return {
        kind,
        definition: readDefinition(json.definition, kind),
        from: readString(json.from, "from"),
      } as Intent;
    case "rename-from":
      return {
        kind,
        definition: readDefinition(json.definition, kind),
        to: readString(json.to, "to"),
      } as Intent;
    case "auto": {
      const ref = asObject(json.autoDefinition, "autoDefinition");
      requireOnlyFields(ref, ["id"], kind);
      return {
        kind,
        autoDefinition: { id: readId(ref.id, "autoDefinition.id") },
      } as Intent;
    }
    case "lockfile":
      return { kind } as Intent;
  }
}

function readModel(value: unknown, kind: IntentKind): ModelRef {
  const ref = asObject(value, "model");
  requireOnlyFields(ref, ["type", "id"], kind);
  const type = readString(ref.type, "model.type");
  let normalized: string;
  try {
    normalized = ModelType.create(type).normalized;
  } catch {
    throw new Error(`Intent ${kind} has an invalid model type: ${type}`);
  }
  if (normalized !== type) {
    throw new Error(
      `Intent ${kind} must carry a normalized model type: ${type}`,
    );
  }
  const required = CONTROL_PLANE_INTENT_TYPES[kind];
  if (required !== undefined && normalizeModelTypeName(type) !== required) {
    throw new Error(
      `Intent ${kind} needs a model of type ${required}, not ${type}`,
    );
  }
  return { type, id: readId(ref.id, "model.id") };
}

function readDefinition(value: unknown, kind: IntentKind): DefinitionRef {
  const ref = asObject(value, "definition");
  requireOnlyFields(ref, ["kind", "name"], kind);
  const definitionKind = ref.kind;
  if (!DEFINITION_KINDS.includes(definitionKind as DefinitionKind)) {
    throw new Error(
      `Intent ${kind} has an unknown definition kind: ${
        String(definitionKind)
      }`,
    );
  }
  if (
    (kind === "evaluated-workflow.save" ||
      kind === "evaluated-workflow.delete") && definitionKind !== "workflow"
  ) {
    throw new Error(`Intent ${kind} needs a workflow definition`);
  }
  return {
    kind: definitionKind as DefinitionKind,
    name: readString(ref.name, "definition.name"),
  };
}

/** A data name, by the rule DataMetadataSchema applies. */
function readDataName(value: unknown): string {
  const name = readString(value, "data name");
  if (
    name.includes("..") || name.includes("/") || name.includes("\\") ||
    name.includes("\0")
  ) {
    throw new Error(
      `Data name must not contain '..', '/', '\\' or NUL: ${name}`,
    );
  }
  return name;
}

function readVersion(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(
      `A data version must be a positive integer: ${String(value)}`,
    );
  }
  return value;
}

/**
 * An aggregate id, lowercased as {@link partitionOf} lowercases it, so the
 * identity serve authorises on is the identity the partition holds.
 */
function readId(value: unknown, label: string): string {
  return readString(value, label).toLowerCase();
}

function readString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Intent ${label} must be a non-empty string`);
  }
  if (value.length > MAX_FIELD_LENGTH) {
    throw new Error(
      `Intent ${label} is longer than ${MAX_FIELD_LENGTH} characters`,
    );
  }
  return value;
}

function asObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireOnlyFields(
  json: Record<string, unknown>,
  allowed: readonly string[],
  kind: IntentKind,
): void {
  for (const field of Object.keys(json)) {
    if (!allowed.includes(field) && json[field] !== undefined) {
      throw new Error(`Intent ${kind} does not take the field '${field}'`);
    }
  }
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
