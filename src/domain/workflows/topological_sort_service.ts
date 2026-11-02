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

export interface GraphNode {
  name: string;
  weight: number;
  dependencies: string[];
  group?: { key: string; index: number };
}

export interface TopologicalSortResult {
  levels: string[][];
}

export class CyclicDependencyError extends Error {
  constructor(readonly cycle: string[]) {
    super(`Cyclic dependency detected: ${cycle.join(" -> ")}`);
    this.name = "CyclicDependencyError";
  }
}

export class DuplicateNodeNameError extends Error {
  constructor(readonly duplicates: string[]) {
    super(`Duplicate node names: ${duplicates.join(", ")}`);
    this.name = "DuplicateNodeNameError";
  }
}

export class TopologicalSortService {
  sort(nodes: GraphNode[]): TopologicalSortResult {
    const seen = new Set<string>();
    const duplicates = new Set<string>();
    for (const node of nodes) {
      if (seen.has(node.name)) {
        duplicates.add(node.name);
      }
      seen.add(node.name);
    }
    if (duplicates.size > 0) {
      throw new DuplicateNodeNameError([...duplicates].sort());
    }

    const inDegree = new Map<string, number>();
    const dependents = new Map<string, string[]>();
    const nodeMap = new Map<string, GraphNode>();

    for (const node of nodes) {
      inDegree.set(node.name, 0);
      dependents.set(node.name, []);
      nodeMap.set(node.name, node);
    }

    for (const node of nodes) {
      for (const dep of node.dependencies) {
        if (nodeMap.has(dep)) {
          const current = inDegree.get(node.name) ?? 0;
          inDegree.set(node.name, current + 1);
          const deps = dependents.get(dep) ?? [];
          deps.push(node.name);
          dependents.set(dep, deps);
        }
        // Dependencies to unknown nodes are ignored
        // (validation service will catch these)
      }
    }

    const levels: string[][] = [];
    const processed = new Set<string>();

    while (processed.size < nodes.length) {
      const available: GraphNode[] = [];
      for (const node of nodes) {
        if (!processed.has(node.name) && inDegree.get(node.name) === 0) {
          available.push(node);
        }
      }

      if (available.length === 0) {
        const cycle = this.findCycle(nodes, processed);
        throw new CyclicDependencyError(cycle);
      }

      // a group sorts by its key and keeps its members in index order, so a
      // forEach's iterations run in list order
      available.sort((a, b) => {
        if (a.weight !== b.weight) {
          return a.weight - b.weight;
        }
        const byKey = (a.group?.key ?? a.name).localeCompare(
          b.group?.key ?? b.name,
        );
        if (byKey !== 0) return byKey;
        const byIndex = (a.group?.index ?? 0) - (b.group?.index ?? 0);
        if (byIndex !== 0) return byIndex;
        return a.name.localeCompare(b.name);
      });

      const level = available.map((n) => n.name);
      levels.push(level);

      for (const node of available) {
        processed.add(node.name);

        for (const dependent of dependents.get(node.name) ?? []) {
          const current = inDegree.get(dependent) ?? 0;
          inDegree.set(dependent, current - 1);
        }
      }
    }

    return { levels };
  }

  private findCycle(nodes: GraphNode[], processed: Set<string>): string[] {
    const unprocessed = nodes.filter((n) => !processed.has(n.name));
    const nodeMap = new Map<string, GraphNode>();
    for (const node of unprocessed) {
      nodeMap.set(node.name, node);
    }

    const visiting = new Set<string>();
    const path: string[] = [];

    const dfs = (name: string): string[] | null => {
      if (visiting.has(name)) {
        const cycleStart = path.indexOf(name);
        return [...path.slice(cycleStart), name];
      }

      const node = nodeMap.get(name);
      if (!node) return null;

      visiting.add(name);
      path.push(name);

      for (const dep of node.dependencies) {
        if (nodeMap.has(dep)) {
          const cycle = dfs(dep);
          if (cycle) return cycle;
        }
      }

      path.pop();
      visiting.delete(name);
      return null;
    };

    for (const node of unprocessed) {
      const cycle = dfs(node.name);
      if (cycle) return cycle;
    }

    // Fallback: return first unprocessed node (shouldn't happen)
    return unprocessed.map((n) => n.name);
  }

  flatten(result: TopologicalSortResult): string[] {
    return result.levels.flat();
  }
}
