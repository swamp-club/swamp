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

import type { Resource } from "@opentelemetry/resources";

// One identity across signals, fresh for each process/counter reset.
const serviceInstanceId = crypto.randomUUID();

/**
 * shared by traces and logs so both report an identical service identity; takes
 * already-loaded SDK constructors so this stays a leaf with no eager SDK cost
 */
export function buildOtelResource(
  ResourceCtor: typeof Resource,
  envDetectorSync: { detect(): Resource },
  attributes: {
    serviceNameAttr: string;
    serviceVersionAttr: string;
  },
  envGet: (key: string) => string | undefined = Deno.env.get.bind(Deno.env),
): Resource {
  const serviceName = envGet("OTEL_SERVICE_NAME") ?? "swamp";

  return ResourceCtor.default()
    .merge(new ResourceCtor({ "service.instance.id": serviceInstanceId }))
    .merge(envDetectorSync.detect())
    .merge(
      new ResourceCtor({
        [attributes.serviceNameAttr]: serviceName,
        [attributes.serviceVersionAttr]: envGet("SWAMP_VERSION") ?? "dev",
        "swamp.version": envGet("SWAMP_BUILD_VERSION") ??
          envGet("SWAMP_VERSION") ?? "dev",
      }),
    );
}
