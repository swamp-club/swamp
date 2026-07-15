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

import { assertEquals } from "@std/assert";
import { envDetectorSync, Resource } from "@opentelemetry/resources";
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from "@opentelemetry/semantic-conventions";
import { buildOtelResource } from "./otel_resource.ts";

const ATTRS = {
  serviceNameAttr: ATTR_SERVICE_NAME,
  serviceVersionAttr: ATTR_SERVICE_VERSION,
};

function withEnv(
  vars: Record<string, string | undefined>,
  fn: () => void,
): void {
  const saved: Record<string, string | undefined> = {};
  for (const key of Object.keys(vars)) {
    saved[key] = Deno.env.get(key);
  }
  try {
    for (const [key, value] of Object.entries(vars)) {
      if (value === undefined) Deno.env.delete(key);
      else Deno.env.set(key, value);
    }
    fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) Deno.env.delete(key);
      else Deno.env.set(key, value);
    }
  }
}

Deno.test("buildOtelResource: defaults service.name to 'swamp' and version to 'dev'", () => {
  withEnv(
    { OTEL_SERVICE_NAME: undefined, SWAMP_VERSION: undefined },
    () => {
      const resource = buildOtelResource(Resource, envDetectorSync, ATTRS);
      assertEquals(resource.attributes[ATTR_SERVICE_NAME], "swamp");
      assertEquals(resource.attributes[ATTR_SERVICE_VERSION], "dev");
    },
  );
});

Deno.test("buildOtelResource: honors OTEL_SERVICE_NAME and SWAMP_VERSION", () => {
  withEnv(
    { OTEL_SERVICE_NAME: "asdlc-harness", SWAMP_VERSION: "1.2.3" },
    () => {
      const resource = buildOtelResource(Resource, envDetectorSync, ATTRS);
      assertEquals(resource.attributes[ATTR_SERVICE_NAME], "asdlc-harness");
      assertEquals(resource.attributes[ATTR_SERVICE_VERSION], "1.2.3");
    },
  );
});

Deno.test("buildOtelResource: picks up OTEL_RESOURCE_ATTRIBUTES via envDetectorSync", () => {
  withEnv(
    {
      OTEL_SERVICE_NAME: undefined,
      SWAMP_VERSION: undefined,
      OTEL_RESOURCE_ATTRIBUTES: "deployment.environment=staging",
    },
    () => {
      const resource = buildOtelResource(Resource, envDetectorSync, ATTRS);
      assertEquals(
        resource.attributes["deployment.environment"],
        "staging",
      );
    },
  );
});
