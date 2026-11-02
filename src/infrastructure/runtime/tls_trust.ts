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
 * compiled swamp ignores the OS trust store by default (UnknownIssuer behind
 * private CAs); Deno reads CA env vars lazily and children inherit them, so
 * setting them before the first network call suffices
 */

const DENO_TLS_CA_STORE = "DENO_TLS_CA_STORE";
const DENO_CERT = "DENO_CERT";
const SSL_CERT_FILE = "SSL_CERT_FILE";

/**
 * system adds the OS trust store; mozilla keeps Deno's bundled roots so public
 * TLS still works when the OS store is empty or misconfigured
 */
const DEFAULT_CA_STORE = "system,mozilla";

export interface TlsTrustEnv {
  DENO_TLS_CA_STORE?: string;
  DENO_CERT?: string;
  SSL_CERT_FILE?: string;
}

/**
 * never overrides a value the user has already set; empty strings are treated
 * as unset
 */
export function computeTlsTrustEnv(
  env: TlsTrustEnv,
): Record<string, string> {
  const mutations: Record<string, string> = {};

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
