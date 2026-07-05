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

/**
 * Built-in fleet probe model (see design/remote-execution.md,
 * "Verification: swamp worker verify").
 *
 * A lightweight model whose single method exercises every seam that can
 * break between a worker and the orchestrator: dispatch-level metadata
 * (probeMarker), the capability RPC channel (queryData), and the HTTP
 * data plane (writeResource + readResource).
 */

import { z } from "zod";
import { ModelType } from "../model_type.ts";
import {
  defineModel,
  type MethodContext,
  type MethodResult,
  type ModelDefinition,
} from "../model.ts";

export const FLEET_PROBE_MODEL_TYPE = ModelType.create("swamp/fleet-probe");
export const FLEET_PROBE_DEFINITION_ID = "00000000-0000-4000-8000-000000000001";

const VerifyArgsSchema = z.object({
  probeMarker: z.string().optional(),
});

const ProbeResultSchema = z.object({
  platform: z.string(),
  arch: z.string(),
  probeMarkerOk: z.boolean(),
  queryOk: z.boolean(),
  dataPlaneOk: z.boolean(),
  failures: z.array(z.string()),
});

export type ProbeResult = z.infer<typeof ProbeResultSchema>;

const PROBE_RESOURCE_NAME = "probe-result";

async function verify(
  args: z.infer<typeof VerifyArgsSchema>,
  context: MethodContext,
): Promise<MethodResult> {
  const failures: string[] = [];

  const probeMarkerOk = args.probeMarker !== undefined &&
    args.probeMarker.length > 0;
  if (!probeMarkerOk) {
    failures.push("probeMarker: dispatch-level signal did not arrive");
  }

  let queryOk = false;
  if (context.queryData) {
    try {
      await context.queryData('modelType == "swamp/fleet-probe"');
      queryOk = true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      failures.push(`queryData: capability RPC channel failed (${msg})`);
    }
  } else {
    failures.push("queryData: capability not available");
  }

  let dataPlaneOk = false;
  if (context.writeResource && context.readResource) {
    try {
      await context.writeResource("result", PROBE_RESOURCE_NAME, {
        _probe: true,
      });
      const readBack = await context.readResource(PROBE_RESOURCE_NAME);
      if (readBack !== null) {
        dataPlaneOk = true;
      } else {
        failures.push("dataPlane: write succeeded but read returned null");
      }
    } catch {
      failures.push("dataPlane: write/read round-trip failed");
    }
  } else {
    failures.push("dataPlane: writeResource or readResource not available");
  }

  const result: ProbeResult = {
    platform: Deno.build.os,
    arch: Deno.build.arch,
    probeMarkerOk,
    queryOk,
    dataPlaneOk,
    failures,
  };

  if (!context.writeResource) {
    failures.push("result: writeResource not available, cannot persist result");
    return { dataHandles: [] };
  }

  const handle = await context.writeResource(
    "result",
    PROBE_RESOURCE_NAME,
    result,
  );
  return { dataHandles: [handle] };
}

export const fleetProbeModel: ModelDefinition = defineModel({
  type: FLEET_PROBE_MODEL_TYPE,
  version: "2026.07.04.1",
  resources: {
    "result": {
      description:
        "Fleet probe verification result (per-seam pass/fail with platform info)",
      schema: ProbeResultSchema,
      lifetime: "ephemeral",
      garbageCollection: 1,
    },
  },
  methods: {
    verify: {
      description:
        "Exercise every seam between worker and orchestrator: dispatch metadata, capability RPC, and data plane",
      kind: "action",
      arguments: VerifyArgsSchema,
      execute: verify,
    },
  },
});
