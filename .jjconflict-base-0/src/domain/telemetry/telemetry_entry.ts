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
  createTelemetryId,
  generateTelemetryId,
  type TelemetryId,
} from "./telemetry_id.ts";
import {
  type CommandInvocation,
  type CommandInvocationData,
  commandInvocationToData,
  createCommandInvocation,
} from "./command_invocation.ts";
import {
  type InvocationResult,
  type InvocationResultData,
  invocationResultFromData,
  invocationResultToData,
} from "./invocation_result.ts";

/**
 * Properties required to create a new TelemetryEntry.
 */
export interface CreateTelemetryEntryProps {
  id?: string;
  invocation: CommandInvocationData;
  result: InvocationResultData;
  startedAt: Date;
  completedAt: Date;
  swampVersion: string;
  denoVersion: string;
  platform: string;
}

/**
 * Data transfer object for TelemetryEntry.
 */
export interface TelemetryEntryData {
  id: string;
  invocation: CommandInvocationData;
  result: InvocationResultData;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  swampVersion: string;
  denoVersion: string;
  platform: string;
}

/**
 * TelemetryEntry is the main entity representing a CLI invocation.
 */
export class TelemetryEntry {
  private constructor(
    readonly id: TelemetryId,
    readonly invocation: CommandInvocation,
    readonly result: InvocationResult,
    readonly startedAt: Date,
    readonly completedAt: Date,
    readonly durationMs: number,
    readonly swampVersion: string,
    readonly denoVersion: string,
    readonly platform: string,
  ) {}

  /**
   * Creates a new TelemetryEntry.
   */
  static create(props: CreateTelemetryEntryProps): TelemetryEntry {
    const id = props.id ? createTelemetryId(props.id) : generateTelemetryId();
    const durationMs = props.completedAt.getTime() - props.startedAt.getTime();

    return new TelemetryEntry(
      id,
      createCommandInvocation(props.invocation),
      invocationResultFromData(props.result),
      props.startedAt,
      props.completedAt,
      durationMs,
      props.swampVersion,
      props.denoVersion,
      props.platform,
    );
  }

  /**
   * Reconstructs a TelemetryEntry from persisted data.
   */
  static fromData(data: TelemetryEntryData): TelemetryEntry {
    return new TelemetryEntry(
      createTelemetryId(data.id),
      createCommandInvocation(data.invocation),
      invocationResultFromData(data.result),
      new Date(data.startedAt),
      new Date(data.completedAt),
      data.durationMs,
      data.swampVersion,
      data.denoVersion,
      data.platform,
    );
  }

  /**
   * Converts the TelemetryEntry to a plain data object for persistence.
   */
  toData(): TelemetryEntryData {
    return {
      id: this.id,
      invocation: commandInvocationToData(this.invocation),
      result: invocationResultToData(this.result),
      startedAt: this.startedAt.toISOString(),
      completedAt: this.completedAt.toISOString(),
      durationMs: this.durationMs,
      swampVersion: this.swampVersion,
      denoVersion: this.denoVersion,
      platform: this.platform,
    };
  }
}
