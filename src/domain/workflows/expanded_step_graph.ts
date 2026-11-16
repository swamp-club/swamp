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

import type { ExpandedStep } from "./for_each_expansion_service.ts";
import type { GraphNode } from "./topological_sort_service.ts";

/**
 * The graph of a job's expanded steps. A forEach that expanded to nothing has
 * no node, so a dependency on it is replaced by its own dependencies.
 */
export function buildExpandedStepGraph(
  stepNodes: readonly GraphNode[],
  expandedSteps: ReadonlyMap<string, readonly ExpandedStep[]>,
): GraphNode[] {
  const byName = new Map(stepNodes.map((node) => [node.name, node]));
  const resolved = new Map<string, string[]>();
  const visiting = new Set<string>();
  let cyclesHit = 0;

  const resolve = (dep: string): string[] => {
    const expanded = expandedSteps.get(dep);
    if (expanded && expanded.length > 0) {
      return expanded.map((e) => e.expandedName);
    }
    const node = byName.get(dep);
    // an unknown name is left for the sort to ignore
    if (!node) return [dep];
    const known = resolved.get(dep);
    if (known) return known;
    // only a cycle of empty forEach steps reaches here; workflow validate reports it
    if (visiting.has(dep)) {
      cyclesHit++;
      return [];
    }
    visiting.add(dep);
    const before = cyclesHit;
    const result = unique(node.dependencies.flatMap(resolve));
    visiting.delete(dep);
    // a result cut short by a cycle is partial, so it is not reused
    if (cyclesHit === before) resolved.set(dep, result);
    return result;
  };

  const nodes: GraphNode[] = [];
  for (const node of stepNodes) {
    const expanded = expandedSteps.get(node.name);
    if (!expanded || expanded.length === 0) continue;
    const dependencies = unique(node.dependencies.flatMap(resolve));
    // iterations are grouped under their forEach step so they run in list order
    for (const [index, exp] of expanded.entries()) {
      nodes.push({
        name: exp.expandedName,
        weight: node.weight,
        group: exp.forEachVar.name !== ""
          ? { key: node.name, index }
          : undefined,
        dependencies: [...dependencies],
      });
    }
  }
  return nodes;
}

function unique(names: string[]): string[] {
  return [...new Set(names)];
}
