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

import type {
  InstallContext,
  InstallExtensionFn,
  InstallResult,
} from "./pull.ts";
import { InstallExtensionService } from "./install_extension_service.ts";
import type { ExtensionRepository } from "../../infrastructure/persistence/extension_repository.ts";
import type { DenoRuntime } from "../../domain/runtime/deno_runtime.ts";

/**
 * upgrade is install of the new version, which tombstones other versions in the
 * same saveAll transaction; bulk upgrades are independent; a collision restores
 * the previous lockfile entry and roots
 */
export class UpgradeExtensionService {
  private readonly installService: InstallExtensionService;

  constructor(args: {
    denoRuntime: DenoRuntime;
    repository: ExtensionRepository;
    /**
     * test seam: tests inject a stub to exercise upgrade against a pre-staged
     * on-disk subtree.
     */
    installExtensionFn?: InstallExtensionFn;
  }) {
    this.installService = new InstallExtensionService(args);
  }

  async execute(
    name: string,
    newVersion: string,
    ctx: InstallContext,
  ): Promise<InstallResult | undefined> {
    return await this.installService.execute(
      { name, version: newVersion },
      ctx,
    );
  }
}
