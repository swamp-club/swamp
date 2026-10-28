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
 * Which record keys an intent's aggregate may project to, and which op
 * kinds an intent may ride (swamp-club#3915).
 *
 * Serve authorises a forwarded op on its intent, so it must also check that
 * the op's key is one the intent's aggregate owns. Otherwise a principal
 * allowed to save data on one behavior could write any other aggregate's
 * file, such as a grant's. The layouts here are the ones the repositories
 * write ("v3 repository staging" in `design/enablers/datastores.md`):
 *
 * - `data/{type}/{modelId}/{name}/{version}/raw|metadata.yaml` and
 *   `data/{type}/{modelId}/{name}/latest`;
 * - `outputs/{type}/{method}/{modelId}-{stamp}.yaml`;
 * - `definitions-evaluated/{type}/{name|id}.yaml`;
 * - `workflow-runs/{workflowId}/workflow-run-{runId}.yaml` and
 *   `workflows-evaluated/runs/{runId}/evaluated-workflow.yaml`;
 * - `config/models/{type}/{name|id}.yaml`,
 *   `config/workflows/workflow-{name|id}.yaml`,
 *   `config/vaults/{type}/{id}.yaml` and
 *   `workflows-evaluated/workflow-{name|id}.yaml`;
 * - `auto-definitions/{type}/{name|id}.yaml`;
 * - `config/upstream_extensions.json`.
 *
 * A key a repository names by a uuid rather than a name belongs to whichever
 * definition holds that id, which only a lookup can tell: the binding
 * returns the id, and the authoriser's key-ownership rule guards the key.
 * `integration/v3_write_path_authorization_test.ts` runs every repository
 * write through these rules, so the two cannot drift.
 *
 * @module
 */

import { ModelType } from "../models/model_type.ts";
import type { Intent, IntentKind } from "./intent.ts";
import type { RecordKey } from "./record_key.ts";

/** The op kinds that carry an intent. */
export type IntentOpKind = "put" | "tombstone";

/** Why a key is not one an intent's aggregate owns. */
export type KeyBindingRefusal =
  | "key-outside-aggregate"
  | "op-kind-not-allowed"
  | "definition-type-unknown";

/** The outcome of binding an op's key to its intent. */
export type KeyBinding =
  | {
    readonly ok: true;
    /**
     * The id a definition file is named by, when it is named by one. The
     * layout alone cannot tie it to the intent's definition: authorisation
     * relies on key ownership (a key another partition owns is refused) and,
     * for the puts whose content serve checks, on admin.
     */
    readonly fileId?: string;
    /**
     * The name a file of an aggregate whose intent carries only an id is
     * named by. As for {@link fileId}, ownership guards it, not the name.
     */
    readonly fileName?: string;
    /**
     * The behavior type the key's directory names, for a behavior
     * definition, an auto-definition, an evaluated definition or a vault
     * config.
     */
    readonly type?: ModelType;
  }
  | { readonly ok: false; readonly reason: KeyBindingRefusal };

const BOTH: readonly IntentOpKind[] = ["put", "tombstone"];
const PUT: readonly IntentOpKind[] = ["put"];
const TOMBSTONE: readonly IntentOpKind[] = ["tombstone"];

/**
 * Which op kinds each intent kind may ride, from what the repositories
 * stage. It is not a verb split:
 * - a version-less `data.delete` or `data.gc` puts the lowered latest marker
 *   or tombstones it;
 * - a move's old key is tombstoned under its create or edit intent;
 * - the control-plane kinds write new record versions, so they are puts.
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

/** Whether `intent` may ride an op of `opKind`. */
export function opKindAllowed(intent: Intent, opKind: IntentOpKind): boolean {
  return OP_KINDS[intent.kind].includes(opKind);
}

/** The key of the managed-config extension lockfile. */
export const LOCKFILE_RECORD_KEY = "config/upstream_extensions.json";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Binds an op's key to its intent: whether the key is one the intent's
 * aggregate owns, and whether the intent may ride this op kind.
 */
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
 * What a record key of a behavior's partition holds, from its layout alone
 * (swamp-club#4006): `data` for a key under the behavior's data directory,
 * `model` for one of its outputs or evaluated definitions, undefined for a
 * key the behavior's intents never write. A compacted record no longer
 * carries the intent that wrote it, so the base is filtered on this.
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

/**
 * A key under the behavior's data directory, in the data layout. With
 * `names`, the key must be under one of those data names; with a version, under that version's
 * directory or the name's latest marker. `only` narrows it to one of the
 * two.
 */
function dataKey(
  model: { readonly type: string; readonly id: string },
  segments: readonly string[],
  names?: readonly string[],
  version?: number,
  only?: "latest" | "version",
): KeyBinding | undefined {
  if (segments[0] !== "data") return undefined;
  // `data/{type}/{id}/...`: the type spans one or more segments, so find
  // the id that follows it.
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

/** An output file name, `<definitionId>-<stamp>.yaml` as the repository writes it. */
const OUTPUT_FILE = /^(.+)-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)\.yaml$/;

function isOutputFileOf(file: string, modelId: string): boolean {
  return OUTPUT_FILE.exec(file)?.[1] === modelId;
}

/** A managed-config definition's file, by its kind's layout. */
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

/** How a typed file may be named. */
interface FileNaming {
  /** Ids the file may be named by; a uuid stem must be one of them. */
  readonly ids?: readonly string[];
  /** Names the file may be named by. */
  readonly names?: readonly string[];
  /** Any other name is accepted, returned for the caller to check. */
  readonly anyName?: boolean;
}

/**
 * `{root}/{type}/{file}.yaml`. A uuid stem must be one of `ids` when they
 * are given, and is returned for the caller to check otherwise.
 */
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

/** `{prefix}{name}.yaml` for one of `names`, or `{prefix}{uuid}.yaml`. */
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

/**
 * The behavior type spelled by `segments[from..to)`, when it is a type in
 * its normalized form: a key never holds another spelling.
 */
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
