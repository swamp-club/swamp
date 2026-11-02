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

import {
  freeRoots,
  literalCallTexts,
  staticAccessPath,
} from "./cel_grammar.ts";
import {
  AUTHORED_ORIGIN,
  extractExpressions,
  readSetMap,
  type SpliceOrigin,
} from "./expression_parser.ts";
import { scanExpressions } from "./expression_scanner.ts";
import {
  indexPath,
  keyPath,
  keySegment,
  ProvenanceMap,
} from "./provenance_map.ts";

/**
 * only namespaces that can hold authored values are listed; every other
 * namespace is data by definition. A namespace with no map is authored, with
 * data marked where it enters.
 */
export interface BindingProvenance {
  inputs?: ProvenanceMap;
  self?: ProvenanceMap;
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

export function bindingProvenanceOf(
  context: object | undefined,
): BindingProvenance {
  return (context as CarriesBindingProvenance | undefined)?.[
    BINDING_PROVENANCE
  ] ?? {};
}

const AUTHORED_ROOTS = new Set(["inputs", "self", "run", "model"]);

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
      return segments.length < 2
        ? modelNamespaceMap(context, segments)
        : ProvenanceMap.data();
    }
    default:
      return ProvenanceMap.data();
  }
}

function modelNamespaceMap(
  context: object | undefined,
  segments: readonly (string | number)[],
): ProvenanceMap {
  const model = (context as { model?: Record<string, unknown> } | undefined)
    ?.model ?? {};
  const names = segments.length === 1
    ? [String(segments[0])]
    : Object.keys(model);
  // Built in one pass: a withWholeData call per path copies the map each
  // time, quadratic in the number of models the context binds.
  const whole: string[] = [];
  for (const name of names) {
    const entry = model[name];
    if (entry === null || typeof entry !== "object") continue;
    for (const field of Object.keys(entry)) {
      if (MODEL_DEFINITION_FIELDS.has(field)) continue;
      whole.push(
        segments.length === 1
          ? keySegment(field)
          : keyPath(keySegment(name), field),
      );
    }
  }
  return ProvenanceMap.fromEntries(whole, []);
}

/**
 * a subtree that is wholly data is skipped unread: nothing in it could be
 * authored, and reading it would fire the loaders the model namespace puts on
 * resources and files
 */
function authoredRawsIn(
  value: unknown,
  map: ProvenanceMap,
  into: Set<string>,
): void {
  if (map.isWholeData) return;
  const visit = (node: unknown, path: string): void => {
    if (typeof node === "string") {
      for (const span of scanExpressions(node)) {
        if (!map.overlapsData(path, span.start, span.end)) into.add(span.raw);
      }
    } else if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) {
        const itemPath = indexPath(path, i);
        if (!map.isWholeDataAt(itemPath)) visit(node[i], itemPath);
      }
    } else if (node !== null && typeof node === "object") {
      for (const key of Object.keys(node)) {
        const childPath = keyPath(path, key);
        if (!map.isWholeDataAt(childPath)) {
          visit((node as Record<string, unknown>)[key], childPath);
        }
      }
    }
  };
  visit(value, "");
}

/**
 * the author wrote literal() output as text, so it is data wherever it lands,
 * even where the same expression is also written as one
 */
function literalOutputRaws(celExpression: string): Set<string> {
  const raws = new Set<string>();
  if (!celExpression.includes("literal")) return raws;
  for (const text of literalCallTexts(celExpression) ?? []) {
    for (const expr of extractExpressions(text)) raws.add(expr.raw);
  }
  return raws;
}

/**
 * a direct binding read carries that binding's map; any computation is data
 * except occurrences authored in the bindings it read (whole roots) or its own
 * text. literal() output is always data.
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
  const rootMaps = new Map<string, ProvenanceMap>();
  for (const root of roots) {
    if (!AUTHORED_ROOTS.has(root)) {
      // Every namespace outside the allow-list is data.
      readsData = true;
      continue;
    }
    const map = bindingMapAt(context, root, []);
    rootMaps.set(root, map);
    if (!map.isAuthored) readsData = true;
  }
  const produced = literalOutputRaws(celExpression);
  if (!readsData && produced.size === 0) return AUTHORED_ORIGIN;
  const authoredRaws = new Set<string>(
    extractExpressions(celExpression).map((e) => e.raw),
  );
  const ctx = context as Record<string, unknown> | undefined;
  for (const [root, map] of rootMaps) {
    authoredRawsIn(ctx?.[root], map, authoredRaws);
  }
  for (const raw of produced) authoredRaws.delete(raw);
  return { map: readSetMap(value, authoredRaws), authoredRaws };
}
