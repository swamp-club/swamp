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
  type DriverTypeInfo,
  driverTypeRegistry,
} from "./driver_type_registry.ts";
import {
  DockerDriverConfigSchema,
  DockerExecutionDriver,
} from "./docker_execution_driver.ts";

export type { DriverTypeInfo } from "./driver_type_registry.ts";

/**
 * Built-in execution driver type definitions.
 */
const BUILT_IN_DRIVER_TYPES: DriverTypeInfo[] = [
  {
    type: "raw",
    name: "Raw (In-Process)",
    description:
      "Execute model methods directly in the host Deno process. This is the default driver with no isolation.",
    isBuiltIn: true,
  },
  {
    type: "docker",
    name: "Docker",
    description:
      "Execute model methods in isolated Docker containers. Provides process-level isolation and reproducibility.",
    isBuiltIn: true,
    configSchema: DockerDriverConfigSchema,
    createDriver: (config) => new DockerExecutionDriver(config),
  },
];

// Register built-in types on module load
for (const driverType of BUILT_IN_DRIVER_TYPES) {
  if (!driverTypeRegistry.has(driverType.type)) {
    driverTypeRegistry.register(driverType);
  }
}

/**
 * Gets all available driver types.
 */
export function getDriverTypes(): DriverTypeInfo[] {
  return driverTypeRegistry.getAll();
}

/**
 * Gets a driver type by its identifier.
 */
export function getDriverType(type: string): DriverTypeInfo | undefined {
  return driverTypeRegistry.get(type);
}
