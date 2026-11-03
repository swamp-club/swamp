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
 * serve authorises on the intent, so it must also check the op's key belongs to
 * the intent's aggregate; else a principal allowed to save one behavior's data
 * could write another aggregate's file, such as a grant's
 */

import { ModelType } from "../models/model_type.ts";
import type { Intent, IntentKind } from "./intent.ts";
import type { RecordKey } from "./record_key.ts";

export type IntentOpKind = "put" | "tombstone";

export type KeyBindingRefusal =
  | "key-outside-aggregate"
  | "op-kind-not-allowed"
  | "definition-type-unknown";

export type KeyBinding =
  | {
    readonly ok: true;
    /**
     * the layout cannot tie it to the intent's definition; authorisation relies
     * on key ownership and, for puts whose content serve checks, on admin
     */
    readonly fileId?: string;
    /**
     * The name a file of an aggregate whose intent carries only an id is
     * named by. As for {@link fileId}, ownership guards it, not the name.
     */
    readonly fileName?: string;
    readonly type?: ModelType;
  }
  | { readonly ok: false; readonly reason: KeyBindingRefusal };

const BOTH: readonly IntentOpKind[] = ["put", "tombstone"];
const PUT: readonly IntentOpKind[] = ["put"];
const TOMBSTONE: readonly IntentOpKind[] = ["tombstone"];

/**
 * not a verb split: a version-less data.delete or data.gc puts the lowered
 * latest marker or tombstones it; a move tombstones its old key under create or
 * edit; control-plane kinds write new versions, so put
 */
const OP_KINDS: Readonly<Record<IntentKind, readonly IntentOpKind[]>> = {
  "data.save": PUT,
  "data.append": PUT,
  "data.delete": BOTH,
  "data.gc": BOTH,
  "data.rename": PUT,
  "output.save": PUT,
  "output.delete": TOMBSTONE,
  "evaluated-definition.save": PUT,
  "evaluated-definition.delete": TOMBSTONE,
  "grant.create": PUT,
  "grant.revoke": PUT,
  "group.create": PUT,
  "group.update": PUT,
  "token.create": PUT,
  "token.revoke": PUT,
  "token.rotate": PUT,
  "worker-token.create": PUT,
  "worker-token.revoke": PUT,
  "worker.delete": BOTH,
  "run.create": PUT,
  "run.update": PUT,
  "run.delete": TOMBSTONE,
  "run-snapshot.save": PUT,
  "run-snapshot.delete": TOMBSTONE,
  "run-start.save": PUT,
  "run-start.delete": TOMBSTONE,
  "definition.create": BOTH,
  "definition.edit": BOTH,
  "definition.delete": TOMBSTONE,
  "evaluated-workflow.save": PUT,
  "evaluated-workflow.delete": TOMBSTONE,
  "definition.rename-to": PUT,
  "definition.rename-from": TOMBSTONE,
  "auto-definition.save": PUT,
  "auto-definition.delete": TOMBSTONE,
  "lockfile.write": PUT,
};

export function opKindAllowed(intent: Intent, opKind: IntentOpKind): boolean {
  return OP_KINDS[intent.kind].includes(opKind);
}

export const LOCKFILE_RECORD_KEY = "config/upstream_extensions.json";

const STEP_START_FILE_PATTERN = /^[0-9a-f]{64}\.yaml$/;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function bindKey(
  intent: Intent,
  opKind: IntentOpKind,
  key: RecordKey,
): KeyBinding {
  if (!opKindAllowed(intent, opKind)) {
    return { ok: false, reason: "op-kind-not-allowed" };
  }
  const segments = key.toString().split("/");
  const owned = bindSegments(intent, segments);
  return owned ?? { ok: false, reason: "key-outside-aggregate" };
}

function bindSegments(
  intent: Intent,
  segments: readonly string[],
): KeyBinding | undefined {
  switch (intent.kind) {
    case "data.save":
    case "data.append":
      return dataKey(intent.model, segments, [intent.name], intent.version);
    case "data.delete":
    case "data.gc":
      // A versioned removal tombstones that version's files; a version-less
      // one changes only the name's latest marker.
      return dataKey(
        intent.model,
        segments,
        [intent.name],
        intent.version,
        intent.version === undefined ? "latest" : "version",
      );
    case "data.rename":
      return dataKey(intent.model, segments, [intent.name, intent.to]);
    case "grant.create":
    case "grant.revoke":
    case "group.create":
    case "group.update":
    case "token.create":
    case "token.revoke":
    case "token.rotate":
    case "worker-token.create":
    case "worker-token.revoke":
    case "worker.delete":
      return dataKey(intent.model, segments);
    case "output.save":
    case "output.delete":
      // `outputs/{type}/{method}/{modelId}-{stamp}.yaml`, where the type may
      // span segments: the file is named by its behavior's id, which the
      // output repository finds a behavior's outputs by.
      return segments.length >= 4 && segments[0] === "outputs" &&
          typeUnder(segments, 1, segments.length - 2)?.normalized ===
            intent.model.type &&
          isOutputFileOf(segments[segments.length - 1], intent.model.id)
        ? { ok: true }
        : undefined;
    case "evaluated-definition.save":
    case "evaluated-definition.delete":
      return typedFile(segments, "definitions-evaluated", intent.model.type, {
        ids: [intent.model.id],
        anyName: true,
      });
    case "run.create":
    case "run.update":
    case "run.delete":
      return segments.length === 3 && segments[0] === "workflow-runs" &&
          segments[1] === intent.run.workflowId &&
          segments[2] === `workflow-run-${intent.run.runId}.yaml`
        ? { ok: true }
        : undefined;
    case "run-start.save":
    case "run-start.delete":
      return segments.length === 5 && segments[0] === "workflow-runs" &&
          segments[1] === intent.run.workflowId && segments[2] === "starts" &&
          segments[3] === intent.run.runId &&
          STEP_START_FILE_PATTERN.test(segments[4])
        ? { ok: true }
        : undefined;
    case "run-snapshot.save":
    case "run-snapshot.delete":
      return segments.length === 4 && segments[0] === "workflows-evaluated" &&
          segments[1] === "runs" && segments[2] === intent.run.runId &&
          segments[3] === "evaluated-workflow.yaml"
        ? { ok: true }
        : undefined;
    case "definition.create":
    case "definition.edit":
    case "definition.delete":
      return definitionKey(intent.definition, segments, [
        intent.definition.name,
      ]);
    case "definition.rename-to":
      return definitionKey(intent.definition, segments, [
        intent.definition.name,
        intent.from,
      ]);
    case "definition.rename-from":
      return definitionKey(intent.definition, segments, [
        intent.definition.name,
        intent.to,
      ]);
    case "evaluated-workflow.save":
    case "evaluated-workflow.delete":
      return segments.length === 2 && segments[0] === "workflows-evaluated"
        ? namedFile(segments[1], "workflow-", [intent.definition.name])
        : undefined;
    case "auto-definition.save":
    case "auto-definition.delete":
      return typedFile(segments, "auto-definitions", undefined, {
        ids: [intent.autoDefinition.id],
        anyName: true,
      });
    case "lockfile.write":
      return segments.join("/") === LOCKFILE_RECORD_KEY
        ? { ok: true }
        : undefined;
  }
}

/**
 * judged from layout alone because a compacted record does not carry the intent
 * that wrote it, so the base is filtered on this
 */
export function modelRecordKind(
  model: { readonly type: string; readonly id: string },
  key: RecordKey,
): "data" | "model" | undefined {
  const segments = key.toString().split("/");
  if (dataKey(model, segments) !== undefined) return "data";
  const intents: readonly Intent[] = [
    // The output binding reads only the model, never the output id.
    { kind: "output.save", model, outputId: "" },
    { kind: "evaluated-definition.save", model },
  ];
  for (const intent of intents) {
    if (bindSegments(intent, segments)?.ok === true) return "model";
  }
  return undefined;
}

function dataKey(
  model: { readonly type: string; readonly id: string },
  segments: readonly string[],
  names?: readonly string[],
  version?: number,
  only?: "latest" | "version",
): KeyBinding | undefined {
  if (segments[0] !== "data") return undefined;
  const typeSegments = model.type.split("/");
  const idIndex = 1 + typeSegments.length;
  for (let i = 0; i < typeSegments.length; i++) {
    if (segments[1 + i] !== typeSegments[i]) return undefined;
  }
  if (segments[idIndex] !== model.id) return undefined;
  const rest = segments.slice(idIndex + 1);
  if (rest.length === 0) return undefined;
  const [name, ...below] = rest;
  if (names !== undefined && !names.includes(name)) return undefined;
  if (below.length === 1 && below[0] === "latest") {
    return only === "version" ? undefined : { ok: true };
  }
  if (below.length !== 2 || only === "latest") return undefined;
  const [versionSegment, file] = below;
  if (file !== "raw" && file !== "metadata.yaml") return undefined;
  if (!/^[1-9][0-9]*$/.test(versionSegment)) return undefined;
  if (version !== undefined && Number(versionSegment) !== version) {
    return undefined;
  }
  return { ok: true };
}

const OUTPUT_FILE = /^(.+)-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)\.yaml$/;

function isOutputFileOf(file: string, modelId: string): boolean {
  return OUTPUT_FILE.exec(file)?.[1] === modelId;
}

function definitionKey(
  definition: { readonly kind: string; readonly name: string },
  segments: readonly string[],
  names: readonly string[],
): KeyBinding | undefined {
  if (segments[0] !== "config") return undefined;
  switch (definition.kind) {
    case "model":
      return typedFile(segments.slice(1), "models", undefined, { names });
    case "vault":
      // A vault config is always stored by id.
      return typedFile(segments.slice(1), "vaults", undefined, {});
    case "workflow":
      return segments.length === 3 && segments[1] === "workflows"
        ? namedFile(segments[2], "workflow-", names)
        : undefined;
  }
  return undefined;
}

interface FileNaming {
  readonly ids?: readonly string[];
  readonly names?: readonly string[];
  readonly anyName?: boolean;
}

function typedFile(
  segments: readonly string[],
  root: string,
  expectedType: string | undefined,
  naming: FileNaming,
): KeyBinding | undefined {
  if (segments.length < 3 || segments[0] !== root) return undefined;
  const type = typeUnder(segments, 1, segments.length - 1);
  if (type === undefined) {
    return { ok: false, reason: "definition-type-unknown" };
  }
  if (expectedType !== undefined && type.normalized !== expectedType) {
    return undefined;
  }
  const file = segments[segments.length - 1];
  if (!file.endsWith(".yaml")) return undefined;
  const stem = file.slice(0, -".yaml".length);
  if (UUID_PATTERN.test(stem)) {
    if (naming.ids === undefined) return { ok: true, fileId: stem, type };
    return naming.ids.includes(stem) ? { ok: true, type } : undefined;
  }
  if (naming.names?.includes(stem)) return { ok: true, type };
  return naming.anyName ? { ok: true, fileName: stem, type } : undefined;
}

function namedFile(
  file: string,
  prefix: string,
  names: readonly string[],
): KeyBinding | undefined {
  if (!file.startsWith(prefix) || !file.endsWith(".yaml")) return undefined;
  const stem = file.slice(prefix.length, -".yaml".length);
  if (UUID_PATTERN.test(stem)) return { ok: true, fileId: stem };
  return names.includes(stem) ? { ok: true } : undefined;
}

function typeUnder(
  segments: readonly string[],
  from: number,
  to: number,
): ModelType | undefined {
  if (to <= from) return undefined;
  const spelled = segments.slice(from, to).join("/");
  let type: ModelType;
  try {
    type = ModelType.create(spelled);
  } catch {
    return undefined;
  }
  return type.normalized === spelled ? type : undefined;
}
