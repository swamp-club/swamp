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

import type { DispatchService } from "./dispatch_service.ts";
import type { UnifiedDataRepository } from "../domain/data/repositories.ts";
import {
  FLEET_PROBE_DEFINITION_ID,
  FLEET_PROBE_MODEL_TYPE,
  fleetProbeModel,
} from "../domain/models/worker/fleet_probe_model.ts";
import type { WorkerProbeResult } from "./protocol.ts";

export async function dispatchFleetProbe(
  dispatchService: DispatchService,
  dataRepo: UnifiedDataRepository,
  workerName: string,
  marker: string,
  signal?: AbortSignal,
): Promise<WorkerProbeResult> {
  try {
    const result = await dispatchService.executeRemote({
      placement: { target: workerName },
      modelDef: fleetProbeModel,
      modelType: FLEET_PROBE_MODEL_TYPE,
      modelId: FLEET_PROBE_DEFINITION_ID,
      methodName: "verify",
      definitionName: "probe",
      definitionTags: {},
      definitionMeta: {
        id: FLEET_PROBE_DEFINITION_ID,
        name: "probe",
        version: 1,
        tags: {},
      },
      globalArgs: {},
      methodArgs: {},
      probeMarker: marker,
      skipScheduler: true,
      signal,
    });

    const output = result.outputs.find((o) => o.specName === "result");
    if (output) {
      const bytes = await dataRepo.getContent(
        FLEET_PROBE_MODEL_TYPE,
        FLEET_PROBE_DEFINITION_ID,
        output.name,
        output.version,
      );
      if (bytes) {
        const content = JSON.parse(
          new TextDecoder().decode(bytes),
        ) as Record<string, unknown>;
        const allOk = content.probeMarkerOk === true &&
          content.queryOk === true && content.dataPlaneOk === true;
        return {
          name: workerName,
          status: allOk ? "pass" : "fail",
          platform: content.platform as string,
          arch: content.arch as string,
          probeMarkerOk: content.probeMarkerOk as boolean,
          queryOk: content.queryOk as boolean,
          dataPlaneOk: content.dataPlaneOk as boolean,
          failures: content.failures as string[],
        };
      }
      return {
        name: workerName,
        status: "error",
        error: "Probe output not readable",
      };
    }
    return {
      name: workerName,
      status: "error",
      error: "No probe result in dispatch output",
    };
  } catch (error) {
    return {
      name: workerName,
      status: "error",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
