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

/**
 * Builds the OpenTelemetry {@link Resource} shared by every swamp signal
 * (traces and logs). Both the tracer provider and the logger provider consume
 * this so log records and spans report an identical service identity —
 * `service.name`, `service.version`, and any operator-supplied
 * `OTEL_RESOURCE_ATTRIBUTES` (picked up by `envDetectorSync`) — and therefore
 * collate under the same service in the backend.
 *
 * The `@opentelemetry/resources` package is dynamically imported by callers,
 * so this builder receives the already-loaded constructors and detectors as
 * arguments rather than importing the SDK itself. That keeps it a leaf module
 * with no eager SDK cost when telemetry is disabled.
 */
export function buildOtelResource(
  ResourceCtor: typeof Resource,
  envDetectorSync: { detect(): Resource },
  attributes: {
    serviceNameAttr: string;
    serviceVersionAttr: string;
  },
): Resource {
  const serviceName = Deno.env.get("OTEL_SERVICE_NAME") ?? "swamp";

  return ResourceCtor.default()
    .merge(envDetectorSync.detect())
    .merge(
      new ResourceCtor({
        [attributes.serviceNameAttr]: serviceName,
        [attributes.serviceVersionAttr]: Deno.env.get("SWAMP_VERSION") ?? "dev",
      }),
    );
}
