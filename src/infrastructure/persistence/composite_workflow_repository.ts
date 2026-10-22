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

import type { WorkflowRepository } from "../../domain/workflows/repositories.ts";
import type { WorkflowId } from "../../domain/workflows/workflow_id.ts";
import type { Workflow } from "../../domain/workflows/workflow.ts";
import {
  listWorkflows,
  type WorkflowListing,
} from "../../domain/workflows/workflow_listing.ts";

/**
 * Composite WorkflowRepository that merges a primary (mutable) repository
 * with an optional extension (read-only) repository.
 *
 * - `findByName`/`findById`: Checks primary first, falls back to extension.
 * - `findAll`/`findAllListings`: Merges both, deduplicating by name
 *   (primary wins).
 * - `save`/`delete`/`nextId`/`getPath`: Delegates to primary.
 */
export class CompositeWorkflowRepository implements WorkflowRepository {
  constructor(
    private readonly primary: WorkflowRepository,
    private readonly extension: WorkflowRepository | null,
  ) {}

  async findById(id: WorkflowId): Promise<Workflow | null> {
    const primary = await this.primary.findById(id);
    if (primary) return primary;

    if (this.extension) {
      return await this.extension.findById(id);
    }
    return null;
  }

  async findByName(name: string): Promise<Workflow | null> {
    const primary = await this.primary.findByName(name);
    if (primary) return primary;

    if (this.extension) {
      return await this.extension.findByName(name);
    }
    return null;
  }

  async findAll(): Promise<Workflow[]> {
    const primaryWorkflows = await this.primary.findAll();

    if (!this.extension) {
      return primaryWorkflows;
    }

    const extensionWorkflows = await this.extension.findAll();

    // Deduplicate by name — primary wins
    const primaryNames = new Set(primaryWorkflows.map((w) => w.name));
    const uniqueExtension = extensionWorkflows.filter(
      (w) => !primaryNames.has(w.name),
    );

    return [...primaryWorkflows, ...uniqueExtension];
  }

  /** The listings of `findAll`, deduplicated by name the same way. */
  async findAllListings(): Promise<WorkflowListing[]> {
    const primary = await listWorkflows(this.primary);
    if (!this.extension) return primary;
    const primaryNames = new Set(primary.map((w) => w.name));
    const extension = (await listWorkflows(this.extension)).filter(
      (w) => !primaryNames.has(w.name),
    );
    return [...primary, ...extension];
  }

  /**
   * The primary's workflows with `id`, then the extension's that no primary
   * workflow shadows by name, as `findAll` leaves them out.
   */
  async findAllById(id: WorkflowId): Promise<Workflow[]> {
    const primary = await workflowsWithId(this.primary, id);
    if (!this.extension) return primary;
    const unshadowed: Workflow[] = [];
    for (const workflow of await workflowsWithId(this.extension, id)) {
      if (!(await this.primary.findByName(workflow.name))) {
        unshadowed.push(workflow);
      }
    }
    return [...primary, ...unshadowed];
  }

  /**
   * The same composite over the live primary and the extension's memoized
   * view, so the extension workflows are read at most once for the view's
   * life. The primary's lookups are already cheap and stay live.
   */
  memoizedView(): WorkflowRepository {
    if (!this.extension?.memoizedView) return this;
    return new CompositeWorkflowRepository(
      this.primary,
      this.extension.memoizedView(),
    );
  }

  async save(workflow: Workflow): Promise<void> {
    await this.primary.save(workflow);
  }

  async delete(id: WorkflowId, name?: string): Promise<void> {
    await this.primary.delete(id, name);
  }

  nextId(): WorkflowId {
    return this.primary.nextId();
  }

  getPath(id: WorkflowId): string {
    return this.primary.getPath(id);
  }
}

/** The workflows of `repo` that declare `id`, by its own listing when it has one. */
async function workflowsWithId(
  repo: WorkflowRepository,
  id: WorkflowId,
): Promise<Workflow[]> {
  return repo.findAllById
    ? await repo.findAllById(id)
    : (await repo.findAll()).filter((workflow) => workflow.id === id);
}
