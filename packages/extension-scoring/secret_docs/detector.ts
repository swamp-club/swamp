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

import { namesSecretValue } from "./secret_names.ts";

/**
 * the registry runs this over archives it did not author, so every pattern is
 * linear in line length and lines past MAX_SCANNED_LINE_LENGTH are skipped
 */

export type SecretDocsForm =
  | "markdown"
  | "plain"
  | "source";

export interface SecretDocsFinding {
  line: number;
  message: string;
}

export const MAX_SCANNED_LINE_LENGTH = 2000;

const MAX_CONTINUATION_LINES = 20;

const VAULT_EXPRESSION = "${{ vault.get(<vault>, <key>) }}";

const UNSUPPORTED_SYNTAX: ReadonlyArray<{ pattern: RegExp; label: string }> = [
  { pattern: /\bvault:\/\//i, label: "`vault://`" },
  { pattern: /<vault:/i, label: "`<vault:`" },
  { pattern: /(?<!\$)\{\{\s{0,8}vault\b/, label: "`{{ vault ... }}`" },
  {
    pattern: /\bswamp\s{1,8}vault\s{1,8}set\b/,
    label: "`swamp vault set` (the command is `swamp vault put`)",
  },
];

const ARG_ASSIGNMENT =
  /--(global-arg|input)(?:\s{1,8}|=)["']?([A-Za-z_][\w.-]{0,100})=(\S{0,8})/g;

const VAULT_PUT = /\bswamp\s{1,8}vault\s{1,8}(?:put|write-secret)\b(.*)$/;

const VAULT_PUT_VALUE_FLAGS = new Set([
  "--repo-dir",
  "--refresh-from",
  "--refresh-ttl",
  "--label",
  "--server",
  "--token",
  "--token-file",
  "--ca-cert",
]);

/**
 * A value that is a shell variable reference, bare or in double quotes:
 * `$TOKEN`, `"${TOKEN}"`. Single quotes pass the text literally.
 */
const SHELL_VARIABLE =
  /^(?:\$(?:[A-Za-z_]\w{0,100}|\{[A-Za-z_]\w{0,100}\})|"\$(?:[A-Za-z_]\w{0,100}|\{[A-Za-z_]\w{0,100}\})")$/;

const SHELL_OPERATOR = /^(?:\|\|?|&&?|;|\d?>>?|<<?<?)$/;

const CREDENTIAL_SHAPES: ReadonlyArray<{ pattern: RegExp; label: string }> = [
  {
    pattern: /(?<![A-Za-z0-9])(?:ghp|gho|ghs|ghu|ghr)_[A-Za-z0-9]{36,255}/,
    label: "a GitHub token",
  },
  {
    pattern: /(?<![A-Za-z0-9])github_pat_[A-Za-z0-9_]{60,255}/,
    label: "a GitHub token",
  },
  {
    pattern: /(?<![A-Za-z0-9])glpat-[A-Za-z0-9_-]{20,255}/,
    label: "a GitLab token",
  },
  {
    pattern: /(?<![A-Za-z0-9])sk-ant-[A-Za-z0-9_-]{20,255}/,
    label: "an Anthropic API key",
  },
  {
    pattern: /(?<![A-Za-z0-9])(?:AKIA|ASIA)[A-Z0-9]{16}(?![A-Za-z0-9])/,
    label: "an AWS access key",
  },
  {
    pattern: /(?<![A-Za-z0-9])xox[abprs]-[A-Za-z0-9-]{10,255}/,
    label: "a Slack token",
  },
  {
    pattern: /(?<![A-Za-z0-9])hvs\.[A-Za-z0-9_-]{24,255}/,
    label: "a HashiCorp Vault token",
  },
  {
    pattern: /(?<![A-Za-z0-9])swamp_[A-Za-z0-9]{20,255}/,
    label: "a swamp API key",
  },
  {
    pattern: /\bBearer[ \t]{1,8}[A-Za-z0-9_\-.~+/]{20,1000}/,
    label: "a bearer token",
  },
  {
    pattern:
      /\b[a-z][a-z0-9+.-]{1,20}:\/\/[^\s:/@]{1,100}:[^\s@/$<{]{1,200}@([^\s/:?#]{1,253})/i,
    label: "a password in a URL",
  },
];

/**
 * A placeholder that only has a credential's shape: a run of one repeated
 * character (`glpat-xxxxxxxxxxxxxxxxxxxx`).
 */
const REPEATED_RUN = /(.)\1{7}/;

/**
 * Hosts a URL with a password may name in docs: local test databases and
 * the documentation domains.
 */
const DOCUMENTATION_HOST =
  /^(?:localhost|127(?:\.\d{1,3}){3}|\[::1\]|(?:[\w-]{1,63}\.){0,8}example\.(?:com|org|net))$/i;

export interface ArgumentSchemas {
  sensitive: ReadonlySet<string>;
  declared: ReadonlySet<string>;
}

const NO_SCHEMAS: ArgumentSchemas = {
  sensitive: new Set(),
  declared: new Set(),
};

const SOURCE_DOC_STRING =
  /(?:\.describe\(\s{0,8}|\bdescription\s{0,8}:\s{0,8})(?:"([^"\n]{0,2000})"|'([^'\n]{0,2000})'|`([^`\n]{0,2000})`)/g;

const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/**
 * schemas: a name is a secret when a schema marks it sensitive, or when no
 * schema declares it and namesSecretValue accepts it; a declared non-sensitive
 * name (secretKey, naming a vault key) is the schema's call
 */
export function detectSecretDocs(
  text: string,
  form: SecretDocsForm,
  schemas: ArgumentSchemas = NO_SCHEMAS,
): SecretDocsFinding[] {
  const findings: SecretDocsFinding[] = [];
  for (const segment of segments(text, form)) {
    const problems = segment.code
      ? [
        ...unsupportedSyntax(segment.text),
        ...argAssignments(segment.text, schemas),
        ...vaultPutValue(segment.text),
        ...credentialShapes(segment.text),
      ]
      : credentialShapes(segment.text);
    const unique = [...new Set(problems)];
    if (unique.length === 0) continue;
    findings.push({
      line: segment.line,
      message: `Line ${segment.line} ${unique.join("; ")}. Keep secrets in ` +
        `a vault: store them with \`swamp vault put <vault> <key>\`, which ` +
        `prompts for the value, and reference them as \`${VAULT_EXPRESSION}\`.`,
    });
  }
  return findings;
}

interface Segment {
  line: number;
  text: string;
  code: boolean;
}

export interface SchemaField {
  name: string;
  sensitive?: boolean;
}

export interface SchemaMetadata {
  models: readonly {
    globalArguments: readonly SchemaField[];
    methods: readonly { arguments: readonly SchemaField[] }[];
  }[];
  extensions?: readonly {
    methods: readonly { arguments: readonly SchemaField[] }[];
  }[];
  vaults: readonly { configFields: readonly SchemaField[] }[];
  datastores: readonly { configFields: readonly SchemaField[] }[];
}

/**
 * The argument and config field names an extension's schemas declare and
 * mark sensitive, for {@link detectSecretDocs}. Without metadata nothing is
 * declared, so the name heuristic decides every argument.
 */
export function argumentSchemas(
  metadata: SchemaMetadata | null | undefined,
): ArgumentSchemas {
  if (!metadata) return NO_SCHEMAS;
  const sensitive = new Set<string>();
  const declared = new Set<string>();
  const fields = [
    ...metadata.models.flatMap((m) => [
      ...m.globalArguments,
      ...m.methods.flatMap((method) => method.arguments),
    ]),
    ...(metadata.extensions ?? []).flatMap((e) =>
      e.methods.flatMap((method) => method.arguments)
    ),
    ...metadata.vaults.flatMap((v) => v.configFields),
    ...metadata.datastores.flatMap((d) => d.configFields),
  ];
  for (const field of fields) {
    declared.add(field.name);
    if (field.sensitive) sensitive.add(field.name);
  }
  return { sensitive, declared };
}

function segments(text: string, form: SecretDocsForm): Segment[] {
  const lines = text.split("\n");
  if (form === "source") return sourceSegments(lines);

  const out: Segment[] = [];
  let fence: string | undefined;
  let pending: { line: number; parts: string[] } | undefined;
  const flush = () => {
    if (pending) {
      out.push({
        line: pending.line,
        text: pending.parts.join(" "),
        code: true,
      });
      pending = undefined;
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.length > MAX_SCANNED_LINE_LENGTH) {
      flush();
      continue;
    }
    if (form === "markdown") {
      const marker = FENCE.exec(line)?.[1];
      if (marker !== undefined) {
        if (fence === undefined) {
          fence = marker;
          continue;
        }
        if (marker[0] === fence[0] && marker.length >= fence.length) {
          flush();
          fence = undefined;
          continue;
        }
      }
      if (fence === undefined) {
        out.push({ line: i + 1, text: line, code: false });
        continue;
      }
    }
    // A command continued with a trailing backslash is one command: its
    // arguments are checked together and reported on its first line.
    const continued = /\\\s*$/.test(line);
    const body = continued ? line.replace(/\\\s*$/, "") : line;
    if (pending) pending.parts.push(body);
    else pending = { line: i + 1, parts: [body] };
    if (!continued || pending.parts.length >= MAX_CONTINUATION_LINES) flush();
  }
  flush();
  return out;
}

function sourceSegments(lines: string[]): Segment[] {
  const out: Segment[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.length > MAX_SCANNED_LINE_LENGTH) continue;
    const strings: string[] = [];
    for (const match of line.matchAll(SOURCE_DOC_STRING)) {
      strings.push(match[1] ?? match[2] ?? match[3] ?? "");
    }
    if (strings.length > 0) {
      out.push({ line: i + 1, text: strings.join(" "), code: true });
    }
  }
  return out;
}

function unsupportedSyntax(text: string): string[] {
  return UNSUPPORTED_SYNTAX.filter(({ pattern }) => pattern.test(text)).map((
    { label },
  ) => `uses ${label}, which swamp does not resolve as a vault reference`);
}

function argAssignments(text: string, schemas: ArgumentSchemas): string[] {
  const problems: string[] = [];
  for (const match of text.matchAll(ARG_ASSIGNMENT)) {
    const [, flag, name, valueStart] = match;
    const secret = schemas.sensitive.has(name) ||
      (!schemas.declared.has(name) && namesSecretValue(name));
    if (!secret) continue;
    const value = valueStart.replace(/^["']/, "");
    if (value.startsWith("${{")) continue;
    // A flag such as `create_project_token=true` holds no secret.
    if (/^(?:true|false)["']?$/i.test(value)) continue;
    problems.push(
      `sets the secret \`--${flag} ${name}\` to a value written in the ` +
        "docs instead of a vault expression",
    );
  }
  return problems;
}

function vaultPutValue(text: string): string[] {
  // Inline code in prose ends the command at its closing backtick.
  const rest = VAULT_PUT.exec(text)?.[1].split("`")[0];
  if (rest === undefined) return [];
  const positionals: string[] = [];
  const tokens = shellTokens(rest);
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (SHELL_OPERATOR.test(token) || token.startsWith("#")) break;
    if (token.startsWith("-")) {
      const flag = token.split("=")[0];
      if (flag === "--server") return [];
      if (VAULT_PUT_VALUE_FLAGS.has(flag) && !token.includes("=")) i++;
      continue;
    }
    positionals.push(token);
  }
  const value = positionals.length >= 3
    ? positionals[2]
    : positionals.length === 2 && positionals[1].includes("=")
    ? positionals[1].slice(positionals[1].indexOf("=") + 1)
    : undefined;
  // A shell variable, bare or double-quoted, puts only its name in history.
  return value !== undefined && !SHELL_VARIABLE.test(value)
    ? [
      "passes the secret's value to `swamp vault put` on the command line, " +
      "where shell history keeps it",
    ]
    : [];
}

/**
 * Splits a command line on whitespace, keeping quoted spans whole. A `|`,
 * `;` or `&` glued to a word is split off so the command ends there.
 */
function shellTokens(text: string): string[] {
  const tokens: string[] = [];
  for (const match of text.matchAll(/"[^"]*"|'[^']*'|[^\s"'|;&]+|[|;&]+/g)) {
    tokens.push(match[0]);
  }
  return tokens;
}

function credentialShapes(text: string): string[] {
  const problems: string[] = [];
  for (const { pattern, label } of CREDENTIAL_SHAPES) {
    const global = new RegExp(pattern.source, pattern.flags + "g");
    for (const match of text.matchAll(global)) {
      if (REPEATED_RUN.test(match[0])) continue;
      if (match[1] !== undefined && DOCUMENTATION_HOST.test(match[1])) continue;
      problems.push(`contains what looks like ${label}`);
      break;
    }
  }
  return problems;
}

export const SECRET_UNSAFE_DOCS_RULE = "secret-unsafe-docs";

export interface SecretDocsLocatedFinding {
  file?: string;
  line: number;
  message: string;
}

export const MAX_STORED_SECRET_DOCS_FINDINGS = 50;

export const MAX_SCANNED_SECRET_DOCS_FINDINGS = 1000;

export const MAX_SECRET_DOCS_FILE_BYTES = 1024 * 1024;

export const MAX_SECRET_DOCS_FILES = 10_000;

export type SecretDocsAccepted = (finding: SecretDocsLocatedFinding) => boolean;

export interface SecretDocsAcceptance {
  rule: string;
  file?: string;
  line?: number;
}

/**
 * The acceptances that cover secret-unsafe-docs findings: one in a file
 * covers the finding on its line, and one without a file covers every
 * finding in the manifest description.
 */
export function secretDocsAcceptanceMatcher(
  acceptances: readonly SecretDocsAcceptance[] | null | undefined,
): SecretDocsAccepted {
  const lines = new Set<string>();
  let description = false;
  for (const a of acceptances ?? []) {
    if (a.rule !== SECRET_UNSAFE_DOCS_RULE) continue;
    if (a.file === undefined) description = true;
    else if (a.line !== undefined) lines.add(`${a.file}\0${a.line}`);
  }
  return (f) =>
    f.file === undefined ? description : lines.has(`${f.file}\0${f.line}`);
}

export interface SecretDocsResult {
  passed: boolean;
  findings: SecretDocsLocatedFinding[];
  count: number;
  truncated: boolean;
}

/**
 * The outcome from the unaccepted findings: passed only when there are none
 * and the scan covered everything. Unchecked documentation is unknown, not
 * safe.
 */
export function summarizeSecretDocs(
  findings: SecretDocsLocatedFinding[],
  truncated: boolean,
): SecretDocsResult {
  return {
    passed: findings.length === 0 && !truncated,
    findings: findings.slice(0, MAX_STORED_SECRET_DOCS_FINDINGS),
    count: findings.length,
    truncated,
  };
}
