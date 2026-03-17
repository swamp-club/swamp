// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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
 * A node in a dependency graph.
 */
export interface GraphNode {
  name: string;
  weight: number;
  dependencies: string[];
}

/**
 * Result of a topological sort, organized into levels.
 * Nodes within each level can be executed in parallel.
 */
export interface TopologicalSortResult {
  /**
   * Array of levels, where each level contains node names
   * that can be executed in parallel.
   */
  levels: string[][];
}

/**
 * Error thrown when a cycle is detected in the dependency graph.
 */
export class CyclicDependencyError extends Error {
  constructor(readonly cycle: string[]) {
    super(`Cyclic dependency detected: ${cycle.join(" -> ")}`);
    this.name = "CyclicDependencyError";
  }
}

/**
 * Domain service for topological sorting with weighted tie-breaking.
 *
 * Uses Kahn's algorithm to produce a deterministic order:
 * 1. Nodes are sorted by their dependency level (depth in the graph)
 * 2. Within each level, nodes are sorted by weight (ascending), then name
 *
 * This ensures:
 * - Dependencies are always executed before their dependents
 * - Nodes within a level can be executed in parallel
 * - Identical inputs produce identical outputs
 */
export class TopologicalSortService {
  /**
   * Performs a topological sort on the given nodes.
   *
   * @param nodes Array of nodes with names, weights, and dependencies
   * @returns Sorted result organized into parallel execution levels
   * @throws CyclicDependencyError if a cycle is detected
   */
  sort(nodes: GraphNode[]): TopologicalSortResult {
    // Build adjacency list and in-degree map
    const inDegree = new Map<string, number>();
    const dependents = new Map<string, string[]>();
    const nodeMap = new Map<string, GraphNode>();

    // Initialize all nodes
    for (const node of nodes) {
      inDegree.set(node.name, 0);
      dependents.set(node.name, []);
      nodeMap.set(node.name, node);
    }

    // Count in-degrees and build dependents list
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

    // Process nodes level by level
    while (processed.size < nodes.length) {
      // Find all nodes with in-degree 0 (no unprocessed dependencies)
      const available: GraphNode[] = [];
      for (const node of nodes) {
        if (!processed.has(node.name) && inDegree.get(node.name) === 0) {
          available.push(node);
        }
      }

      if (available.length === 0) {
        // Cycle detected - find and report it
        const cycle = this.findCycle(nodes, processed);
        throw new CyclicDependencyError(cycle);
      }

      // Sort available nodes by weight (ascending), then by name for determinism
      available.sort((a, b) => {
        if (a.weight !== b.weight) {
          return a.weight - b.weight;
        }
        return a.name.localeCompare(b.name);
      });

      // Add this level
      const level = available.map((n) => n.name);
      levels.push(level);

      // Process each node in this level
      for (const node of available) {
        processed.add(node.name);

        // Reduce in-degree of dependents
        for (const dependent of dependents.get(node.name) ?? []) {
          const current = inDegree.get(dependent) ?? 0;
          inDegree.set(dependent, current - 1);
        }
      }
    }

    return { levels };
  }

  /**
   * Finds a cycle in the unprocessed nodes.
   */
  private findCycle(nodes: GraphNode[], processed: Set<string>): string[] {
    const unprocessed = nodes.filter((n) => !processed.has(n.name));
    const nodeMap = new Map<string, GraphNode>();
    for (const node of unprocessed) {
      nodeMap.set(node.name, node);
    }

    // Use DFS to find cycle
    const visiting = new Set<string>();
    const path: string[] = [];

    const dfs = (name: string): string[] | null => {
      if (visiting.has(name)) {
        // Found cycle - extract it from path
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

  /**
   * Flattens levels into a single ordered array.
   * Useful when you need a deterministic order but don't need parallelism.
   */
  flatten(result: TopologicalSortResult): string[] {
    return result.levels.flat();
  }
}
