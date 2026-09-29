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
 * Resolves the argument of an output read — an output id prefix, a model
 * name or a model id — to what the read acts on (swamp-club#2673).
 *
 * The lookup is split from the read so a caller that authorizes can resolve
 * once, authorize the output's owners, and hand the read that same
 * reference: the read then acts on exactly what was authorized, never on a
 * second lookup of the raw string.
 */

import type { Definition } from "../../domain/definitions/definition.ts";
import type { ModelType } from "../../domain/models/model_type.ts";

/** An output with the model type it is filed under. */
export interface TypedOutput<O> {
  output: O;
  type: ModelType;
}

/** The result of matching an output id prefix. */
export interface OutputMatchResult<O> {
  status: "found" | "not_found" | "ambiguous";
  match?: TypedOutput<O>;
  matches?: Array<{ id: string }>;
}

/**
 * What an output-or-model argument names. A model carries its latest
 * output, found as it resolves, so the read never looks one up afterwards.
 */
export type OutputReference<O> =
  | { kind: "output"; match: TypedOutput<O> }
  | {
    kind: "model";
    definition: Definition;
    type: ModelType;
    latest: O | null;
  }
  | { kind: "ambiguous"; ids: string[] }
  | { kind: "not_found" };

/** What an output id argument names. */
export type OutputIdReference<O> =
  | { kind: "output"; match: TypedOutput<O> }
  | { kind: "ambiguous"; ids: string[] }
  | { kind: "not_found" }
  /** Not an output id at all: no 3+ hex-character prefix. */
  | { kind: "invalid" };

/** Lookups an output id argument resolves through. */
export interface OutputIdReferenceDeps<O> {
  isPartialId: (value: string) => boolean;
  matchOutputByPartialId: (idPrefix: string) => Promise<OutputMatchResult<O>>;
}

/** Lookups an output-or-model argument resolves through. */
export interface OutputReferenceDeps<O> extends OutputIdReferenceDeps<O> {
  findDefinitionByIdOrName: (
    idOrName: string,
  ) => Promise<{ definition: Definition; type: ModelType } | null>;
  findLatestOutput: (
    type: ModelType,
    definitionId: string,
  ) => Promise<O | null>;
}

/**
 * Resolves an output id prefix. Only for reads that take an output id and
 * nothing else.
 */
export async function resolveOutputIdReference<O>(
  deps: OutputIdReferenceDeps<O>,
  outputId: string,
): Promise<OutputIdReference<O>> {
  if (!deps.isPartialId(outputId)) return { kind: "invalid" };
  const result = await deps.matchOutputByPartialId(outputId);
  if (result.status === "found" && result.match) {
    return { kind: "output", match: result.match };
  }
  if (result.status === "ambiguous" && result.matches) {
    return { kind: "ambiguous", ids: result.matches.map((m) => m.id) };
  }
  return { kind: "not_found" };
}

/**
 * Resolves an output-or-model argument: a 3+ hex-character string is first
 * matched as an output id prefix across every model; failing that, the
 * argument names a model by name, then by id, and the read takes that
 * model's latest output.
 */
export async function resolveOutputReference<O>(
  deps: OutputReferenceDeps<O>,
  outputIdOrModelName: string,
): Promise<OutputReference<O>> {
  if (deps.isPartialId(outputIdOrModelName)) {
    const byId = await resolveOutputIdReference(deps, outputIdOrModelName);
    if (byId.kind === "output" || byId.kind === "ambiguous") return byId;
  }
  const found = await deps.findDefinitionByIdOrName(outputIdOrModelName);
  if (!found) return { kind: "not_found" };
  return {
    kind: "model",
    definition: found.definition,
    type: found.type,
    latest: await deps.findLatestOutput(found.type, found.definition.id),
  };
}
