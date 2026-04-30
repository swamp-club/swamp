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

import {
  type DriverSource,
  type ResolvedDriverConfig,
  resolveDriverConfig,
} from "./driver_resolution.ts";

/**
 * The five driver-resolution tiers known at step-construction time.
 * The sixth (`definition`) requires the evaluated definition, which is
 * only available inside the step executor — finalize via
 * {@link DriverPlan.withDefinition}.
 */
export interface PreDefinitionTiers {
  cli?: DriverSource;
  step?: DriverSource;
  job?: DriverSource;
  workflow?: DriverSource;
  repo?: DriverSource;
}

/**
 * Two-stage driver resolver. Composing all six tiers in one place
 * (rather than splitting their assembly across {@link runStep} and
 * {@link executeModelMethod}) makes adding a new tier or changing
 * precedence a one-file change.
 *
 * Stage one: assemble the five pre-definition tiers at step
 * construction. Stage two: call {@link withDefinition} once the
 * evaluated definition is in scope. The plan's source tiers stay
 * inspectable via {@link tiers} for tests and debugging.
 */
export class DriverPlan {
  constructor(private readonly _tiers: PreDefinitionTiers) {}

  /**
   * Read-only view of the pre-definition tiers. Useful when callers
   * (tests, observability) need to inspect which tier supplied a value
   * before the plan is finalized.
   */
  get tiers(): Readonly<PreDefinitionTiers> {
    return this._tiers;
  }

  /**
   * Finalize the plan by slotting the `definition` tier between
   * `workflow` and `repo`, then resolve.
   */
  withDefinition(definition: DriverSource): ResolvedDriverConfig {
    return resolveDriverConfig(
      this._tiers.cli,
      this._tiers.step,
      this._tiers.job,
      this._tiers.workflow,
      definition,
      this._tiers.repo,
    );
  }
}
