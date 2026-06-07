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
 * TLS trust bootstrap — runs `configureTlsTrust` as an import side effect.
 *
 * This module MUST be the first import in `main.ts`. Deno builds and caches its
 * rustls root store on the first TLS handshake in the process, after which
 * changes to `DENO_TLS_CA_STORE` / `DENO_CERT` have no effect. ES modules
 * evaluate depth-first in source order, so the first import is fully evaluated
 * before any later import's module body. Heavy dependencies pulled in by other
 * imports (the AWS SDK, OpenTelemetry, etc.) can trigger that first handshake at
 * module-evaluation time — i.e. before any statement in `main.ts`'s body. A
 * function call in the body therefore runs too late.
 *
 * Performing the configuration here, as the side effect of the first-evaluated
 * import, guarantees the trust environment is in place before any other module
 * is evaluated and before the first TLS connection is made.
 *
 * Keep this module's import graph minimal — it must not transitively import
 * anything that opens a TLS connection at evaluation time.
 */

import { configureTlsTrust } from "./tls_trust.ts";

configureTlsTrust();
