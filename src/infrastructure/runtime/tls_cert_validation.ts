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
 * Validate PEM-encoded TLS certificates for common issues that produce
 * misleading errors at connection time.
 *
 * Deno's WebSocket client masks all TLS validation errors as "HTTP/2 not
 * supported by this client" when `createHttpClient({ http2: false })` is
 * used. Catching problems at cert-load time gives users actionable
 * guidance instead of a red herring.
 */

/** basicConstraints OID 2.5.29.19 in DER encoding (tag 06, length 03). */
const BASIC_CONSTRAINTS_OID = new Uint8Array([0x06, 0x03, 0x55, 0x1d, 0x13]);

/** ASN.1 BOOLEAN TRUE: tag 01, length 01, value FF. */
const ASN1_BOOLEAN_TRUE = new Uint8Array([0x01, 0x01, 0xff]);

export interface CertWarning {
  code: "ca-true";
  message: string;
}

/**
 * Check a PEM certificate for issues that will cause connection failures.
 * Returns warnings (not errors) — the cert may still work with non-Deno
 * clients.
 */
export function validateEndEntityCert(pemCert: string): CertWarning[] {
  const warnings: CertWarning[] = [];

  if (hasCaTrue(pemCert)) {
    warnings.push({
      code: "ca-true",
      message:
        "The TLS certificate has basicConstraints CA:TRUE, which Deno's TLS " +
        "validator rejects for server (end-entity) use. WebSocket clients — " +
        "including swamp — will fail to connect. Regenerate with CA:FALSE:\n\n" +
        "  openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 \\\n" +
        "    -keyout server.key -out server.crt -days 365 -nodes \\\n" +
        '    -subj "/CN=$(hostname)" \\\n' +
        '    -addext "subjectAltName=IP:<your-ip>" \\\n' +
        '    -addext "basicConstraints=critical,CA:FALSE"',
    });
  }

  return warnings;
}

/**
 * Detect CA:TRUE in a PEM certificate's basicConstraints extension by
 * scanning the DER encoding.
 *
 * Extension structure:
 *   OID(2.5.29.19) [BOOLEAN(critical)] OCTET-STRING { SEQUENCE { [BOOLEAN(cA)] } }
 *
 * The critical flag is also a BOOLEAN TRUE, so we cannot just scan for
 * any 01 01 FF after the OID. Instead we locate the OCTET STRING (tag
 * 04), enter the inner SEQUENCE (tag 30), and check whether its first
 * element is BOOLEAN TRUE.
 */
export function hasCaTrue(pemCert: string): boolean {
  const der = pemToDer(pemCert);
  if (!der) return false;

  for (let i = 0; i <= der.length - BASIC_CONSTRAINTS_OID.length; i++) {
    if (!bytesMatch(der, i, BASIC_CONSTRAINTS_OID)) continue;

    // Scan forward from after the OID to find the OCTET STRING (tag 04)
    // that wraps the extension value. Skip the optional critical BOOLEAN.
    let pos = i + BASIC_CONSTRAINTS_OID.length;
    const limit = Math.min(pos + 10, der.length);

    while (pos < limit && der[pos] !== 0x04) pos++;
    if (pos >= limit) return false;

    // Skip OCTET STRING tag + length
    pos++;
    if (pos >= der.length) return false;
    pos += der[pos] < 0x80 ? 1 : (der[pos] & 0x7f) + 1;
    if (pos >= der.length) return false;

    // Now we should be at the inner SEQUENCE (tag 30)
    if (der[pos] !== 0x30) return false;
    pos++;
    if (pos >= der.length) return false;
    const seqLen = der[pos];
    pos++;

    // Empty SEQUENCE (30 00) → CA defaults to FALSE
    if (seqLen === 0) return false;

    // First element of SEQUENCE: check for BOOLEAN TRUE (01 01 FF)
    if (pos + 2 < der.length && bytesMatch(der, pos, ASN1_BOOLEAN_TRUE)) {
      return true;
    }

    return false;
  }

  return false;
}

function pemToDer(pem: string): Uint8Array | null {
  const match = pem.match(
    /-----BEGIN CERTIFICATE-----\s*([\s\S]+?)\s*-----END CERTIFICATE-----/,
  );
  if (!match) return null;
  try {
    const binary = atob(match[1].replace(/\s/g, ""));
    return Uint8Array.from(binary, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

function bytesMatch(
  haystack: Uint8Array,
  offset: number,
  needle: Uint8Array,
): boolean {
  for (let k = 0; k < needle.length; k++) {
    if (haystack[offset + k] !== needle[k]) return false;
  }
  return true;
}
