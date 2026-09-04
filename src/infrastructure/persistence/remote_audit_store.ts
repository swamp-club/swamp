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
import type { AuditStore } from "../../domain/serve_audit/audit_store.ts";
import { getSwampLogger } from "../logging/logger.ts";

const logger = getSwampLogger(["serve", "audit", "store"]);

export class RemoteAuditStore implements AuditStore {
  readonly #store: ControlPlaneStore;
  readonly #prefix: string;

  constructor(store: ControlPlaneStore, prefix = "_audit/") {
    this.#store = store;
    this.#prefix = prefix;
  }

  async put(key: string, data: Uint8Array): Promise<void> {
    try {
      await this.#store.put(`${this.#prefix}${key}`, data);
    } catch (error: unknown) {
      logger.warn("Audit store put failed for {key}: {error}", {
        key,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  async get(key: string): Promise<Uint8Array | null> {
    try {
      return await this.#store.get(`${this.#prefix}${key}`);
    } catch (error: unknown) {
      logger.warn("Audit store get failed for {key}: {error}", {
        key,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  async list(prefix: string): Promise<string[]> {
    try {
      const keys = await this.#store.list(`${this.#prefix}${prefix}`);
      return keys.map((k) => k.slice(this.#prefix.length));
    } catch (error: unknown) {
      logger.warn("Audit store list failed for {prefix}: {error}", {
        prefix,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }
}
