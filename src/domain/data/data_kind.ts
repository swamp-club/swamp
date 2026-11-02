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

import { UserError } from "../errors.ts";
import { type Data, RECORD_KIND_TAG } from "./data.ts";

export type DataKind = "file" | "resource";

function asKind(value: string | undefined): DataKind | undefined {
  return value === "file" || value === "resource" ? value : undefined;
}

/**
 * the kind the writer stamped, else the type tag when it names a kind: older
 * versions carry only the type tag, which a spec may set to anything
 */
export function dataKindOf(data: Data): DataKind | undefined {
  return asKind(data.tags[RECORD_KIND_TAG]) ?? asKind(data.tags["type"]);
}

export class DataKindConflictError extends UserError {
  constructor(
    readonly dataName: string,
    readonly prior: { version: number; kind: DataKind; specName: string },
    readonly kind: DataKind,
    readonly model: string,
  ) {
    super(
      `Duplicate data instance name '${dataName}' (version ${prior.version} was written as ${prior.kind} '${prior.specName}'; delete it with swamp data delete ${model} ${dataName} before writing it as a ${kind})`,
    );
    this.name = "DataKindConflictError";
  }
}

/**
 * a data name's live versions share one kind; a delete or rename marker ends a
 * history, so the next write may start one of either kind
 */
export function assertKindContinues(
  prior: Data | null | undefined,
  next: Data,
  modelId: string,
): void {
  if (!prior || prior.isDeleted || next.isDeleted) return;
  const priorKind = dataKindOf(prior);
  const nextKind = dataKindOf(next);
  if (priorKind === undefined || nextKind === undefined) return;
  if (priorKind === nextKind) return;
  throw new DataKindConflictError(
    next.name,
    {
      version: prior.version,
      kind: priorKind,
      specName: prior.tags["specName"] ?? prior.name,
    },
    nextKind,
    prior.tags["modelName"] || modelId,
  );
}
