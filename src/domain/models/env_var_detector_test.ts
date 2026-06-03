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
import { Definition } from "../definitions/definition.ts";
import { detectEnvVarUsageInDefinition } from "./env_var_detector.ts";

Deno.test("detectEnvVarUsageInDefinition: returns empty for no env vars", () => {
  const definition = Definition.create({
    name: "test-model",
    globalArguments: { shell: "/bin/bash", baseUrl: "http://localhost:8080" },
  });
  const usages = detectEnvVarUsageInDefinition(definition);
  assertEquals(usages.length, 0);
});

Deno.test("detectEnvVarUsageInDefinition: detects env var in globalArguments", () => {
  const definition = Definition.create({
    name: "test-model",
    globalArguments: {
      shell: "${{ env.JENKINS_SHELL }}",
      baseUrl: "http://localhost:8080",
    },
  });
  const usages = detectEnvVarUsageInDefinition(definition);
  assertEquals(usages.length, 1);
  assertEquals(usages[0].path, "globalArguments.shell");
  assertEquals(usages[0].envVar, "JENKINS_SHELL");
});

Deno.test("detectEnvVarUsageInDefinition: detects multiple env vars", () => {
  const definition = Definition.create({
    name: "test-model",
    globalArguments: {
      shell: "${{ env.JENKINS_SHELL }}",
      baseUrl: "${{ env.JENKINS_BASE_URL }}",
    },
  });
  const usages = detectEnvVarUsageInDefinition(definition);
  assertEquals(usages.length, 2);
  assertEquals(usages[0].envVar, "JENKINS_SHELL");
  assertEquals(usages[1].envVar, "JENKINS_BASE_URL");
});

Deno.test("detectEnvVarUsageInDefinition: detects env var in method data", () => {
  const definition = Definition.create({
    name: "test-model",
    methods: {
      execute: {
        arguments: {
          run: "curl ${{ env.API_URL }}/health",
        },
      },
    },
  });
  const usages = detectEnvVarUsageInDefinition(definition);
  assertEquals(usages.length, 1);
  assertEquals(usages[0].path, "methods.execute.arguments.run");
  assertEquals(usages[0].envVar, "API_URL");
});

Deno.test("detectEnvVarUsageInDefinition: detects multiple env vars in same expression", () => {
  const definition = Definition.create({
    name: "test-model",
    globalArguments: {
      url: '${{ env.PROTOCOL + "://" + env.HOST }}',
    },
  });
  const usages = detectEnvVarUsageInDefinition(definition);
  assertEquals(usages.length, 2);
  assertEquals(usages[0].envVar, "PROTOCOL");
  assertEquals(usages[1].envVar, "HOST");
});

Deno.test("detectEnvVarUsageInDefinition: ignores non-expression env references", () => {
  const definition = Definition.create({
    name: "test-model",
    globalArguments: {
      note: "Set env.MY_VAR to configure this",
    },
  });
  const usages = detectEnvVarUsageInDefinition(definition);
  assertEquals(usages.length, 0);
});
