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
 * TLS trust-store configuration for the compiled swamp binary.
 *
 * swamp ships as a `deno compile` artifact, so every fetch-based TLS call
 * (registry, model HTTP APIs, source download, update check, telemetry)
 * validates against Deno's bundled Mozilla roots and, by default, ignores the
 * operating-system trust store. Behind a TLS-inspecting middlebox or a
 * privately-rooted CA installed in the OS store, every HTTPS call fails with
 * `invalid peer certificate: UnknownIssuer`.
 *
 * Deno reads its TLS CA environment variables lazily (when the rustls root
 * store is first built for a connection), so setting them in-process before the
 * first network call is honored — no re-exec is required. Child processes
 * spawned via `Deno.Command` inherit this environment, so the embedded-deno
 * subprocesses (registry push/bundle) are covered too.
 *
 * Note: the OpenSSL `SSL_CERT_DIR` directory convention is intentionally NOT
 * handled. Deno's `DENO_CERT` accepts a single PEM file only and has no
 * directory equivalent; users relying on a cert directory are covered by the
 * `system` trust-store default instead.
 */

/** Environment variable names this module consults and may set. */
const DENO_TLS_CA_STORE = "DENO_TLS_CA_STORE";
const DENO_CERT = "DENO_CERT";
const SSL_CERT_FILE = "SSL_CERT_FILE";

/**
 * The default trust store. `system` adds the OS trust store; `mozilla` keeps
 * Deno's bundled roots so public TLS still works even when the OS store is
 * empty or misconfigured.
 */
const DEFAULT_CA_STORE = "system,mozilla";

/** A snapshot of the environment variables relevant to TLS trust. */
export interface TlsTrustEnv {
  DENO_TLS_CA_STORE?: string;
  DENO_CERT?: string;
  SSL_CERT_FILE?: string;
}

/**
 * Pure decision function: given a snapshot of the relevant environment
 * variables, return the mutations to apply. Never overrides a value the user
 * has already set. Empty strings are treated as unset.
 */
export function computeTlsTrustEnv(
  env: TlsTrustEnv,
): Record<string, string> {
  const mutations: Record<string, string> = {};

  // Default to merging the OS trust store with Deno's bundled roots, unless the
  // user has explicitly chosen a store.
  if (!env.DENO_TLS_CA_STORE) {
    mutations[DENO_TLS_CA_STORE] = DEFAULT_CA_STORE;
  }

  // Honor the conventional OpenSSL `SSL_CERT_FILE` by mapping it to the variable
  // Deno actually reads (`DENO_CERT`), unless the user already set `DENO_CERT`.
  if (env.SSL_CERT_FILE && !env.DENO_CERT) {
    mutations[DENO_CERT] = env.SSL_CERT_FILE;
  }

  return mutations;
}

/**
 * Apply the TLS trust configuration to the current process environment. Must be
 * called before any network I/O so Deno picks up the values when it first
 * builds its TLS root store.
 */
export function configureTlsTrust(): void {
  const mutations = computeTlsTrustEnv({
    DENO_TLS_CA_STORE: Deno.env.get(DENO_TLS_CA_STORE),
    DENO_CERT: Deno.env.get(DENO_CERT),
    SSL_CERT_FILE: Deno.env.get(SSL_CERT_FILE),
  });

  for (const [key, value] of Object.entries(mutations)) {
    Deno.env.set(key, value);
  }
}
