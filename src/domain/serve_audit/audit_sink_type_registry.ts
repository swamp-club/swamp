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

import type { AuditSink } from "./audit_sink.ts";

export type AuditSinkFactory = (
  config: Record<string, unknown>,
) => Promise<AuditSink>;

export interface AuditSinkTypeInfo {
  readonly name: string;
  readonly factory: AuditSinkFactory;
}

export class AuditSinkTypeRegistry {
  readonly #types = new Map<string, AuditSinkTypeInfo>();
  #loader: (() => Promise<void>) | undefined;
  #loaded = false;

  register(name: string, factory: AuditSinkFactory): void {
    this.#types.set(name, { name, factory });
  }

  setLoader(loader: () => Promise<void>): void {
    this.#loader = loader;
    this.#loaded = false;
  }

  async ensureLoaded(): Promise<void> {
    if (this.#loaded || !this.#loader) return;
    this.#loaded = true;
    await this.#loader();
  }

  async createSink(
    name: string,
    config: Record<string, unknown>,
  ): Promise<AuditSink> {
    await this.ensureLoaded();
    const info = this.#types.get(name);
    if (!info) {
      throw new Error(
        `Unknown audit sink type: "${name}". Available types: ${
          [...this.#types.keys()].join(", ") || "(none)"
        }`,
      );
    }
    return info.factory(config);
  }

  has(name: string): boolean {
    return this.#types.has(name);
  }

  names(): string[] {
    return [...this.#types.keys()];
  }
}
