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

import { freeRoots, staticAccessPath } from "./cel_grammar.ts";
import {
  AUTHORED_ORIGIN,
  extractExpressions,
  readSetMap,
  type SpliceOrigin,
  valueContainsExpression,
} from "./expression_parser.ts";
import {
  indexPath,
  keyPath,
  keySegment,
  ProvenanceMap,
} from "./provenance_map.ts";

/**
 * Where data sits in the bindings an expression context exposes. Only the
 * namespaces that can hold authored values are listed; every other namespace
 * (`data`, model resources and files, `steps`, `env`, `vault`, `file`,
 * `workers`, `webhook`) is data by definition.
 *
 * A namespace with no map here is authored: data that enters `inputs`, `self`
 * or `run` is marked where it enters (workflow caller inputs, spliced step
 * inputs, routed direct-execution globals, forEach items), so an unmarked
 * binding behaves exactly as it did before provenance existed.
 */
export interface BindingProvenance {
  inputs?: ProvenanceMap;
  /** Keyed like `self`: `globalArguments.x`, forEach variables. */
  self?: ProvenanceMap;
  /** Keyed like `run`: `inputs.x`, `tags.x`. */
  run?: ProvenanceMap;
}

/**
 * Key under which an expression context carries its binding provenance. A
 * symbol is invisible to CEL and object spread copies it, as with the run's
 * sensitive values.
 */
const BINDING_PROVENANCE: unique symbol = Symbol("swamp.bindingProvenance");

interface CarriesBindingProvenance {
  [BINDING_PROVENANCE]?: BindingProvenance;
}

/**
 * Sets binding provenance on a context, replacing the namespaces `provenance`
 * names and keeping the others.
 */
export function attachBindingProvenance<T extends object>(
  context: T,
  provenance: BindingProvenance,
): T {
  const carrier = context as CarriesBindingProvenance;
  carrier[BINDING_PROVENANCE] = {
    ...carrier[BINDING_PROVENANCE],
    ...provenance,
  };
  return context;
}

/** The binding provenance a context carries; empty when none was attached. */
export function bindingProvenanceOf(
  context: object | undefined,
): BindingProvenance {
  return (context as CarriesBindingProvenance | undefined)?.[
    BINDING_PROVENANCE
  ] ?? {};
}

/** Roots whose values may be authored, with how to find their map. */
const AUTHORED_ROOTS = new Set(["inputs", "self", "run", "model"]);

/** `model.<name>.<field>` fields that hold definition source, not data. */
const MODEL_DEFINITION_FIELDS = new Set(["definition", "input"]);

function pathOf(segments: readonly (string | number)[]): string {
  let path = "";
  for (const segment of segments) {
    path = typeof segment === "number"
      ? indexPath(path, segment)
      : keyPath(path, segment);
  }
  return path;
}

/**
 * The provenance of the value at `root` + `segments` in `context`, relative
 * to that value.
 */
export function bindingMapAt(
  context: object | undefined,
  root: string,
  segments: readonly (string | number)[],
): ProvenanceMap {
  const bindings = bindingProvenanceOf(context);
  switch (root) {
    case "inputs":
      return (bindings.inputs ?? ProvenanceMap.authored()).subtree(
        pathOf(segments),
      );
    case "self":
      // The definition's own fields carry no data entries, so they read as
      // authored; a forEach item bound over one (`item: name`) carries its
      // own map at that key.
      return (bindings.self ?? ProvenanceMap.authored()).subtree(
        pathOf(segments),
      );
    case "run":
      return (bindings.run ?? ProvenanceMap.authored()).subtree(
        pathOf(segments),
      );
    case "model": {
      const field = segments[1];
      if (typeof field === "string" && MODEL_DEFINITION_FIELDS.has(field)) {
        return ProvenanceMap.authored();
      }
      // `model` itself or `model.<name>` spans definitions and data.
      return segments.length < 2
        ? modelNamespaceMap(context, segments)
        : ProvenanceMap.data();
    }
    default:
      return ProvenanceMap.data();
  }
}

/** `model` or `model.<name>` read whole: definition parts authored, rest data. */
function modelNamespaceMap(
  context: object | undefined,
  segments: readonly (string | number)[],
): ProvenanceMap {
  const model = (context as { model?: Record<string, unknown> } | undefined)
    ?.model ?? {};
  const names = segments.length === 1
    ? [String(segments[0])]
    : Object.keys(model);
  let map = ProvenanceMap.authored();
  for (const name of names) {
    const entry = model[name];
    if (entry === null || typeof entry !== "object") continue;
    for (const field of Object.keys(entry)) {
      if (MODEL_DEFINITION_FIELDS.has(field)) continue;
      const path = segments.length === 1
        ? keySegment(field)
        : keyPath(keySegment(name), field);
      map = map.withWholeData(path);
    }
  }
  return map;
}

/** Raw text of every expression in `value` that does not overlap data. */
function authoredRawsIn(
  value: unknown,
  map: ProvenanceMap,
  into: Set<string>,
): void {
  if (map.isWholeData || !valueContainsExpression(value)) return;
  for (const expr of extractExpressions(value)) {
    if (
      expr.start !== undefined && expr.end !== undefined &&
      !map.overlapsData(expr.path, expr.start, expr.end)
    ) {
      into.add(expr.raw);
    }
  }
}

/**
 * Where an evaluated value came from, decided by the expression that produced
 * it. A direct read of a binding carries that binding's map. Anything else is
 * a computation: its result is data except expression occurrences whose raw
 * text appears in the authored parts of the bindings it read (over-
 * approximated to whole roots), or in the expression's own text.
 */
export function spliceOrigin(
  celExpression: string,
  context: object | undefined,
  value: unknown,
): SpliceOrigin {
  // Decided from where the value came from, never from what it holds: a
  // fragment of expression syntax from data (`${{ env.X` here, ` }}` in the
  // next splice) must stay data so the pieces cannot join into an expression
  // that reads as authored.
  const access = staticAccessPath(celExpression);
  if (access) {
    const map = bindingMapAt(context, access.root, access.segments);
    if (map.isAuthored) return AUTHORED_ORIGIN;
    const authoredRaws = new Set<string>();
    authoredRawsIn(value, map, authoredRaws);
    return { map, authoredRaws };
  }
  const roots = freeRoots(celExpression) ?? new Set([
    ...AUTHORED_ROOTS,
    "data",
  ]);
  let readsData = false;
  for (const root of roots) {
    if (!AUTHORED_ROOTS.has(root)) {
      // Every namespace outside the allow-list is data.
      readsData = true;
      continue;
    }
    if (!bindingMapAt(context, root, []).isAuthored) readsData = true;
  }
  if (!readsData) return AUTHORED_ORIGIN;
  const authoredRaws = new Set<string>(
    extractExpressions(celExpression).map((e) => e.raw),
  );
  const ctx = context as Record<string, unknown> | undefined;
  for (const root of roots) {
    if (!AUTHORED_ROOTS.has(root)) continue;
    authoredRawsIn(ctx?.[root], bindingMapAt(context, root, []), authoredRaws);
  }
  return { map: readSetMap(value, authoredRaws), authoredRaws };
}
