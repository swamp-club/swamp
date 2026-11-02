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

/** Reading OSV's answer for one npm package version. */

/** A vulnerability's severity as the audit grades it. */
export type OsvSeverity = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL" | "UNKNOWN";

/** One advisory affecting a version. */
export interface OsvVulnerability {
  id: string;
  severity: OsvSeverity;
}

/** OSV answered with something that is not a vulnerability list. */
export class MalformedOsvResponseError extends Error {
  constructor(detail: string) {
    super(`OSV returned ${detail}`);
    this.name = "MalformedOsvResponseError";
  }
}

const CVSS_V3_AV: Record<string, number> = {
  N: 0.85,
  A: 0.62,
  L: 0.55,
  P: 0.20,
};
const CVSS_V3_AC: Record<string, number> = { L: 0.77, H: 0.44 };
const CVSS_V3_PR_U: Record<string, number> = { N: 0.85, L: 0.62, H: 0.27 };
const CVSS_V3_PR_C: Record<string, number> = { N: 0.85, L: 0.68, H: 0.50 };
const CVSS_V3_UI: Record<string, number> = { N: 0.85, R: 0.62 };
const CVSS_V3_CIA: Record<string, number> = { N: 0, L: 0.22, H: 0.56 };

/** A CVSS v3 vector's base score, or null when it is not one. */
export function parseCvssV3BaseScore(vector: string): number | null {
  if (!vector.startsWith("CVSS:3")) return null;
  const parts: Record<string, string> = {};
  for (const seg of vector.split("/")) {
    const [k, v] = seg.split(":");
    if (k && v) parts[k] = v;
  }
  const av = CVSS_V3_AV[parts.AV ?? ""];
  const ac = CVSS_V3_AC[parts.AC ?? ""];
  const scope = parts.S;
  const pr = scope === "C"
    ? CVSS_V3_PR_C[parts.PR ?? ""]
    : CVSS_V3_PR_U[parts.PR ?? ""];
  const ui = CVSS_V3_UI[parts.UI ?? ""];
  const c = CVSS_V3_CIA[parts.C ?? ""];
  const i = CVSS_V3_CIA[parts.I ?? ""];
  const a = CVSS_V3_CIA[parts.A ?? ""];
  if (
    av == null || ac == null || pr == null || ui == null ||
    c == null || i == null || a == null || !scope
  ) {
    return null;
  }
  const iss = 1 - (1 - c) * (1 - i) * (1 - a);
  if (iss <= 0) return 0;
  const exploitability = 8.22 * av * ac * pr * ui;
  const impact = scope === "C"
    ? 7.52 * (iss - 0.029) - 3.25 * Math.pow(iss - 0.02, 15)
    : 6.42 * iss;
  if (impact <= 0) return 0;
  const raw = scope === "C"
    ? 1.08 * (impact + exploitability)
    : impact + exploitability;
  return Math.min(Math.ceil(raw * 10) / 10, 10);
}

const DATABASE_SEVERITIES: Readonly<Record<string, OsvSeverity>> = {
  CRITICAL: "CRITICAL",
  HIGH: "HIGH",
  MEDIUM: "MEDIUM",
  MODERATE: "MEDIUM",
  LOW: "LOW",
};

/**
 * One advisory's severity: the database's own grade when it is one OSV
 * defines, else the highest CVSS score it lists, else UNKNOWN. An entry that
 * is not an object is skipped.
 */
export function extractSeverity(vuln: Record<string, unknown>): OsvSeverity {
  const dbSpecific = vuln.database_specific;
  if (dbSpecific && typeof dbSpecific === "object") {
    const raw = (dbSpecific as Record<string, unknown>).severity;
    if (typeof raw === "string") {
      const grade = DATABASE_SEVERITIES[raw.toUpperCase()];
      if (grade) return grade;
    }
  }
  const entries = vuln.severity;
  if (!Array.isArray(entries)) return "UNKNOWN";
  let highest: OsvSeverity = "UNKNOWN";
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const score = (entry as Record<string, unknown>).score;
    const numeric = typeof score === "number"
      ? score
      : typeof score === "string"
      ? parseCvssV3BaseScore(score)
      : null;
    if (numeric === null) continue;
    if (numeric >= 9.0) return "CRITICAL";
    if (numeric >= 7.0) highest = "HIGH";
    else if (numeric >= 4.0 && highest !== "HIGH") highest = "MEDIUM";
    else if (numeric < 4.0 && highest === "UNKNOWN") highest = "LOW";
  }
  return highest;
}

/**
 * The vulnerabilities in an OSV query response. No `vulns` key means none;
 * a `vulns` that is not a list is a malformed answer, so the dependency is
 * not audited rather than read as clean.
 *
 * @throws MalformedOsvResponseError
 */
export function parseOsvResponse(body: unknown): OsvVulnerability[] {
  if (!body || typeof body !== "object") {
    throw new MalformedOsvResponseError("no JSON object");
  }
  const vulns = (body as Record<string, unknown>).vulns;
  if (vulns === undefined || vulns === null) return [];
  if (!Array.isArray(vulns)) {
    throw new MalformedOsvResponseError("a vulns field that is not a list");
  }
  const out: OsvVulnerability[] = [];
  for (const v of vulns) {
    if (!v || typeof v !== "object") continue;
    const obj = v as Record<string, unknown>;
    out.push({
      id: typeof obj.id === "string" ? obj.id : "unknown",
      severity: extractSeverity(obj),
    });
  }
  return out;
}
