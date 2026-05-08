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

export type {
  DriverOutput,
  ExecutionCallbacks,
  ExecutionDriver,
  ExecutionRequest,
  ExecutionResult,
} from "./execution_driver.ts";

export {
  type DriverTypeInfo,
  DriverTypeRegistry,
  driverTypeRegistry,
} from "./driver_type_registry.ts";

export { getDriverType, getDriverTypes } from "./driver_types.ts";

export { DriverConfigFieldSchema, DriverFieldSchema } from "./driver_config.ts";

export {
  type DriverSource,
  type ResolvedDriverConfig,
  resolveDriverConfig,
} from "./driver_resolution.ts";

export {
  type MethodExecutor,
  RawExecutionDriver,
} from "./raw_execution_driver.ts";
export {
  type DockerDriverConfig,
  DockerDriverConfigSchema,
  DockerExecutionDriver,
} from "./docker_execution_driver.ts";

export { DOCKER_RUNNER_SCRIPT } from "./docker_runner.ts";

export { ExtensionLoader } from "../extensions/extension_loader.ts";
export { driverKindAdapter } from "../extensions/driver_kind_adapter.ts";
