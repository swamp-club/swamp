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

import type { ControlPlaneStore } from "../../domain/datastore/control_plane_store.ts";
import {
  type AppApproval,
  type AppApprovalRepository,
  AppApprovalSchema,
} from "../../domain/apps/app_approval.ts";
import { appNameKey } from "../../domain/apps/app_descriptor.ts";

const APPROVAL_DIR = "app-approvals";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// every serve instance and the CLI read approvals from the shared control plane per request, so a revoke needs no poller
export class ControlPlaneAppApprovalRepository
  implements AppApprovalRepository {
  constructor(private readonly store: ControlPlaneStore) {}

  async get(name: string): Promise<AppApproval | null> {
    const bytes = await this.store.get(this.keyFor(name));
    if (bytes === null) return null;
    const parsed = AppApprovalSchema.safeParse(
      parseJson(decoder.decode(bytes)),
    );
    // A record that cannot be read approves nothing.
    return parsed.success ? parsed.data : null;
  }

  async save(approval: AppApproval): Promise<void> {
    const valid = AppApprovalSchema.parse(approval);
    await this.store.put(
      this.keyFor(valid.name),
      encoder.encode(JSON.stringify(valid)),
    );
  }

  async delete(name: string): Promise<boolean> {
    const key = this.keyFor(name);
    if (await this.store.get(key) === null) return false;
    await this.store.delete(key);
    return true;
  }

  private keyFor(name: string): string {
    return `${APPROVAL_DIR}/${appNameKey(name)}`;
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
