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
 * single source of truth for acceptability: error-level rules, the
 * adversarial-review family and bare-specifiers (the registry cannot score it)
 * are never acceptable, nor are unknown ids
 */

export type RuleSeverityClass = "error" | "warning";

/**
 * decides where an acceptance lives: a site or file finding takes a comment in
 * that file, an extension finding a sidecar entry
 */
export type RuleScope = "site" | "file" | "extension";

export interface RuleCatalogEntry {
  readonly id: string;
  readonly severity: RuleSeverityClass;
  readonly scope: RuleScope;
  /**
   * Whether an author may declare a finding of this rule acceptable, with
   * a reason. Always false for error-level rules.
   */
  readonly acceptable: boolean;
  readonly remediation?: string;
}

export const RULE_CATALOG: readonly RuleCatalogEntry[] = [
  {
    id: "long-line",
    severity: "warning",
    scope: "site",
    acceptable: true,
    remediation:
      "Move embedded data to a file listed under additionalFiles and read it at run time, or wrap the literal across lines.",
  },
  {
    id: "base64-run",
    severity: "warning",
    scope: "site",
    acceptable: true,
    remediation:
      "Load encoded data from a file listed under additionalFiles (or binaries) at run time instead of embedding it in source.",
  },
  {
    id: "deno-command",
    severity: "warning",
    scope: "site",
    acceptable: true,
    remediation:
      "Prefer swamp's own primitives over spawning a subprocess; when one is required, validate every argument and document it in the README.",
  },
  {
    id: "ipv4-address-literals",
    severity: "warning",
    scope: "site",
    acceptable: true,
    remediation:
      "Use RFC 5737 documentation ranges (192.0.2.x, 198.51.100.x, 203.0.113.x) or example.com in examples.",
  },
  {
    id: "file-count",
    severity: "error",
    scope: "extension",
    acceptable: false,
  },
  { id: "hidden-file", severity: "error", scope: "file", acceptable: false },
  { id: "file-type", severity: "error", scope: "file", acceptable: false },
  {
    id: "unreadable-file",
    severity: "error",
    scope: "file",
    acceptable: false,
  },
  { id: "symlink", severity: "error", scope: "file", acceptable: false },
  { id: "file-size", severity: "error", scope: "file", acceptable: false },
  {
    id: "total-size",
    severity: "error",
    scope: "extension",
    acceptable: false,
  },
  { id: "dynamic-code", severity: "error", scope: "site", acceptable: false },
  {
    id: "schema-strictness",
    severity: "warning",
    scope: "site",
    acceptable: true,
    remediation:
      "Declare the properties the behavior reads so CEL expressions can validate against them; keep .passthrough() only beside declared properties.",
  },
  {
    id: "credentials-sensitive-field",
    severity: "warning",
    scope: "site",
    acceptable: true,
    remediation:
      "Mark the field .meta({ sensitive: true }) so swamp vaults its value, or rename it if it holds a reference rather than a secret.",
  },
  {
    id: "testing-completeness",
    severity: "warning",
    scope: "file",
    acceptable: true,
    remediation:
      "Add a sibling <name>_test.ts covering the success and failure paths.",
  },
  // not acceptable: the registry cannot score the extension however the author
  // justifies it, and the fix is mechanical
  {
    id: "bare-specifiers",
    severity: "warning",
    scope: "extension",
    acceptable: false,
    remediation:
      "Map each bare name in the deno.json imports to an explicit npm:, jsr:, node: or URL specifier (such as npm:zod@4), or, in a package.json project, declare it as an npm registry dependency and install it in node_modules; push writes the specifier in its place in the shipped source. Or write the specifier in the source yourself, so the registry scorer can resolve imports. Swamp's lint never applies no-import-prefix, so deno.json needs no exclude for it.",
  },
  // not acceptable: pull refuses a config, lock or package file in an archive,
  // so push always leaves it out
  {
    id: "archive-project-file",
    severity: "warning",
    scope: "extension",
    acceptable: false,
    remediation:
      "Remove the file from additionalFiles, include or the kind directory. The archive's source ships every npm: and jsr: import pinned to the exact version its bundle holds, so consumers need no deno.json, lock or package.json.",
  },
  // not acceptable: Deno never reads the member's lock
  {
    id: "workspace-member-lock",
    severity: "warning",
    scope: "extension",
    acceptable: false,
    remediation:
      "Delete the member's lock and its lock setting. Deno reads only the workspace root's lock for every member, and push bundles against that one.",
  },
  // not acceptable: the lock rule is mechanical
  {
    id: "package-lock-mismatch",
    severity: "warning",
    scope: "extension",
    acceptable: false,
    remediation:
      "Run npm install so node_modules matches package-lock.json, then push again. Until it does, a range package.json declares costs the loose-specifier point unless a deno.lock fixes it.",
  },
  // not acceptable: the registry cannot list the model however the author
  // justifies it, and the fix is mechanical
  {
    id: "uncatalogued-model",
    severity: "warning",
    scope: "file",
    acceptable: false,
    remediation:
      'Write type and version as string literals directly in an unannotated export const model = { ... } object, repeating both after a spread of a shared factory\'s result (e.g. { ...definition, type: "@acme/thing", version: "2026.09.25.1" }). Check the shape with satisfies after the object instead of a type annotation.',
  },
  // not acceptable: a source push could neither read nor load has an unchecked
  // collective, and one that does not load on push will not load for consumers
  {
    id: "unverified-collective",
    severity: "warning",
    scope: "file",
    acceptable: false,
    remediation:
      "Make the source load on its own: fix the import or top-level error the warning names, so push can read the type it registers. Or write its type as a string literal in the export object.",
  },
  // not acceptable: the published page lists nothing however it is justified,
  // so only --yes or --force waives it, on each push
  {
    id: "registry-listing-limit",
    severity: "warning",
    scope: "extension",
    acceptable: false,
    remediation:
      "Over any limit the registry discards the whole listing, though the extension still installs and runs. Split it into several extensions, each under the limit (for example one per API domain, @acme/thing/<domain>), or fold related methods into fewer behaviors.",
  },
  // acceptable: an author targeting only current releases may acknowledge that
  // older clients and workers cannot load the extension
  {
    id: "behavior-spelling",
    severity: "warning",
    scope: "extension",
    acceptable: true,
    remediation:
      "Keep the behavior spelling if every client and worker that installs this extension runs this swamp release or later; otherwise use the model spelling (export const model, extensions/models/, manifest models:). Accept the finding in quality.yaml to stop this prompt.",
  },
  // acceptable: docs may show the wrong form on purpose to warn against it; a
  // finding costs the secret-safe-docs rubric point until fixed or accepted
  {
    id: "secret-unsafe-docs",
    severity: "warning",
    scope: "site",
    acceptable: true,
    remediation:
      "Show secrets going through a vault: store them with swamp vault put <vault> <key>, which prompts for the value, and pass them as ${{ vault.get(<vault>, <key>) }}. If the line shows the wrong form on purpose, accept it with an HTML comment on the line above, or, inside a code block, with a quality.yaml entry naming the file and line (that entry needs this swamp release or later).",
  },
  {
    id: "adversarial-review-report",
    severity: "warning",
    scope: "extension",
    acceptable: false,
    remediation:
      "Run the adversarial review and record its report at the path the finding names.",
  },
  {
    id: "adversarial-review-dimension-issue",
    severity: "warning",
    scope: "extension",
    acceptable: false,
    remediation:
      "Resolve the dimension the review flagged, or record why it stands in the report note.",
  },
  {
    id: "stale-acceptance",
    severity: "warning",
    scope: "site",
    acceptable: false,
    remediation:
      "Remove the acceptance; the finding it named no longer fires there.",
  },
  {
    id: "invalid-acceptance",
    severity: "error",
    scope: "site",
    acceptable: false,
  },
  { id: "fmt", severity: "error", scope: "file", acceptable: false },
  { id: "lint", severity: "error", scope: "file", acceptable: false },
  { id: "dynamic-import", severity: "error", scope: "site", acceptable: false },
  {
    id: "upgrade-chain",
    severity: "error",
    scope: "file",
    acceptable: false,
  },
];

const BY_ID: ReadonlyMap<string, RuleCatalogEntry> = new Map(
  RULE_CATALOG.map((entry) => [entry.id, entry]),
);

export function findRule(ruleId: string): RuleCatalogEntry | undefined {
  return BY_ID.get(ruleId);
}

export function isKnownRule(ruleId: string): boolean {
  return BY_ID.has(ruleId);
}

export function isAcceptableRule(ruleId: string): boolean {
  const entry = BY_ID.get(ruleId);
  return entry !== undefined && entry.severity === "warning" &&
    entry.acceptable;
}

export function remediationFor(ruleId: string): string | undefined {
  return BY_ID.get(ruleId)?.remediation;
}
