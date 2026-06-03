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

// Local mirror of swamp's `createExtensionCelEnvironment` factory.
//
// Why mirrored instead of imported: this package publishes standalone to JSR
// (`.github/workflows/publish-testing.yml` runs `deno check mod.ts` from
// inside this directory), so it cannot import from `../../src/`.
//
// Drift guard: `src/domain/models/testing_package_compat_test.ts` runs both
// this factory and `src/infrastructure/cel/cel_evaluator.ts`'s
// `createExtensionCelEnvironment` and asserts identical results across a
// representative set of expressions plus that each call yields a fresh,
// isolated Environment. If you change one, change the other.

import { Environment } from "cel-js";

export function createExtensionCelEnvironment(): Environment {
  const env = new Environment({ unlistedVariablesAreDyn: true });

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
