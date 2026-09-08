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
import { Resource } from "@opentelemetry/resources";
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from "@opentelemetry/semantic-conventions";
import { buildOtelResource } from "./otel_resource.ts";

const ATTRS = {
  serviceNameAttr: ATTR_SERVICE_NAME,
  serviceVersionAttr: ATTR_SERVICE_VERSION,
};

function fakeEnv(
  vars: Record<string, string>,
): (key: string) => string | undefined {
  return (key: string) => vars[key];
}

function stubDetector(
  attrs: Record<string, string>,
): { detect(): Resource } {
  return { detect: () => new Resource(attrs) };
}

Deno.test("buildOtelResource: defaults service.name to 'swamp' and version to 'dev'", () => {
  const resource = buildOtelResource(
    Resource,
    stubDetector({}),
    ATTRS,
    fakeEnv({}),
  );
  assertEquals(resource.attributes[ATTR_SERVICE_NAME], "swamp");
  assertEquals(resource.attributes[ATTR_SERVICE_VERSION], "dev");
});

Deno.test("buildOtelResource: honors OTEL_SERVICE_NAME and SWAMP_VERSION", () => {
  const resource = buildOtelResource(
    Resource,
    stubDetector({}),
    ATTRS,
    fakeEnv({
      OTEL_SERVICE_NAME: "asdlc-harness",
      SWAMP_VERSION: "1.2.3",
    }),
  );
  assertEquals(resource.attributes[ATTR_SERVICE_NAME], "asdlc-harness");
  assertEquals(resource.attributes[ATTR_SERVICE_VERSION], "1.2.3");
});

Deno.test("buildOtelResource: merges detector attributes into resource", () => {
  const resource = buildOtelResource(
    Resource,
    stubDetector({ "deployment.environment": "staging" }),
    ATTRS,
    fakeEnv({}),
  );
  assertEquals(
    resource.attributes["deployment.environment"],
    "staging",
  );
});
