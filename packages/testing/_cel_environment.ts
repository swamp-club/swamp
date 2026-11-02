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

// mirrored from swamp's createExtensionCelEnvironment because this package
// publishes standalone to JSR and cannot import from src;
// testing_package_compat_test.ts guards drift, so change both together

import { Environment } from "cel-js";

export function createExtensionCelEnvironment(): Environment {
  const env = new Environment({
    unlistedVariablesAreDyn: true,
    enableOptionalTypes: true,
    homogeneousAggregateLiterals: false,
  });

  env.registerOperator(
    "double + int",
    (a: number, b: bigint) => a + Number(b),
  );
  env.registerOperator(
    "int + double",
    (a: bigint, b: number) => Number(a) + b,
  );
  env.registerOperator(
    "double - int",
    (a: number, b: bigint) => a - Number(b),
  );
  env.registerOperator(
    "int - double",
    (a: bigint, b: number) => Number(a) - b,
  );
  env.registerOperator(
    "double * int",
    (a: number, b: bigint) => a * Number(b),
  );
  env.registerOperator(
    "int * double",
    (a: bigint, b: number) => Number(a) * b,
  );
  env.registerOperator(
    "double / int",
    (a: number, b: bigint) => a / Number(b),
  );
  env.registerOperator(
    "int / double",
    (a: bigint, b: number) => Number(a) / b,
  );
  env.registerOperator(
    "double % int",
    (a: number, b: bigint) => a % Number(b),
  );
  env.registerOperator(
    "int % double",
    (a: bigint, b: number) => Number(a) % b,
  );

  return env;
}
