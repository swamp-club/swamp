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

import type { ExtensionContentMetadata } from "./extension_content.ts";
import { namesSecretValue } from "./extension_review_rules.ts";

/**
 * Finds extension documentation that tells users to handle a secret in
 * plaintext, or to reference a vault with syntax swamp does not support
 * (swamp-club#3757). The published README, the manifest description and the
 * schema's describe strings are the setup path users copy, so a secret the
 * docs put on a command line ends up in shell history, `.swamp.yaml` or run
 * history whatever the code marks sensitive.
 *
 * Four patterns, each one decidable from the text alone:
 *
 * - vault reference syntax swamp does not support (`vault://`, `<vault:`,
 *   `{{ vault ...` without the `$`, `swamp vault set`);
 * - `--global-arg` or `--input` setting a secret argument to anything other
 *   than a `${{ ... }}` expression;
 * - `swamp vault put` with the value on the command line, unless the
 *   command talks to a `--server`, where no other form exists, or the value
 *   is a shell variable, whose name alone reaches shell history;
 * - full-length credential shapes (GitHub, GitLab, Anthropic, AWS, Slack,
 *   HashiCorp Vault, swamp keys, bearer tokens, `user:pass@` URLs).
 *
 * In Markdown the first three count only inside fenced code blocks, so
 * prose that names the wrong form to warn against it is left alone;
 * credential shapes count anywhere. Piping a value into `swamp vault put` is
 * the form the CLI's help recommends and is not flagged. Exporting a secret
 * into the environment is not flagged either: some SDKs read their
 * credentials only from there.
 *
 * swamp-club runs the same check over archives it did not author, so every
 * pattern is linear in the line length (bounded repetition, no nested
 * quantifiers) and lines longer than {@link MAX_SCANNED_LINE_LENGTH} are
 * skipped. The long-line safety warning already covers those.
 */

/** How a text is read: which parts of it are documentation to check. */
export type SecretDocsForm =
  /** Markdown: fenced code blocks fully, prose for credential shapes only. */
  | "markdown"
  /** Plain text such as the manifest description: every line. */
  | "plain"
  /** TypeScript source: the string passed to `.describe(...)` or set as `description:`. */
  | "source";

/** One line of documentation that mishandles a secret. */
export interface SecretDocsFinding {
  /** 1-based line the finding starts on. */
  line: number;
  /** What is wrong on the line, and the form to use instead. */
  message: string;
}

/** Lines longer than this are not scanned. */
export const MAX_SCANNED_LINE_LENGTH = 2000;

/** The most source lines one backslash-continued command may join. */
const MAX_CONTINUATION_LINES = 20;

/** The form every secret in the docs should take. */
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

/** `--global-arg name=value` / `--input name=value`, quoted or not. */
const ARG_ASSIGNMENT =
  /--(global-arg|input)(?:\s{1,8}|=)["']?([A-Za-z_][\w.-]{0,100})=(\S{0,8})/g;

/** `swamp vault put` (or its `write-secret` alias) and what follows it. */
const VAULT_PUT = /\bswamp\s{1,8}vault\s{1,8}(?:put|write-secret)\b(.*)$/;

/** `swamp vault put` options that take a value. */
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

/** Shell tokens that end the command's own arguments. */
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

/** The argument names an extension's schemas declare, and those they mark sensitive. */
export interface ArgumentSchemas {
  /** Names marked `.meta({ sensitive: true })` anywhere in the extension. */
  sensitive: ReadonlySet<string>;
  /** Every declared argument and config field name. */
  declared: ReadonlySet<string>;
}

const NO_SCHEMAS: ArgumentSchemas = {
  sensitive: new Set(),
  declared: new Set(),
};

/** A string literal passed to `.describe(...)` or set as `description:`. */
const SOURCE_DOC_STRING =
  /(?:\.describe\(\s{0,8}|\bdescription\s{0,8}:\s{0,8})(?:"([^"\n]{0,2000})"|'([^'\n]{0,2000})'|`([^`\n]{0,2000})`)/g;

/** A Markdown fence opener or closer. */
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/**
 * Checks one text for documentation that mishandles a secret.
 *
 * @param schemas the extension's argument names. A name is a secret when a
 *   schema marks it sensitive, or when no schema declares it and
 *   {@link namesSecretValue} accepts it: a declared name that is not
 *   sensitive (`secretKey`, naming a vault key) is the schema's call.
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

/** A unit of text to check, the line it starts on, and whether all patterns apply. */
interface Segment {
  line: number;
  text: string;
  code: boolean;
}

/**
 * The argument and config field names an extension's schemas declare and
 * mark sensitive, for {@link detectSecretDocs}.
 */
export function argumentSchemas(
  metadata: ExtensionContentMetadata,
): ArgumentSchemas {
  const sensitive = new Set<string>();
  const declared = new Set<string>();
  const fields = [
    ...metadata.models.flatMap((m) => [
      ...m.globalArguments,
      ...m.methods.flatMap((method) => method.arguments),
    ]),
    ...metadata.extensions.flatMap((e) =>
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

/**
 * The top-level `description:` entry of a manifest's YAML text: the line it
 * starts on and its lines, the key line included. A block or multi-line
 * scalar runs while lines are blank or indented. Undefined when there is
 * no such entry.
 */
export function manifestDescriptionLines(
  manifestText: string,
): { line: number; text: string } | undefined {
  const lines = manifestText.split("\n");
  const start = lines.findIndex((l) => /^description\s*:/.test(l));
  if (start === -1) return undefined;
  let end = start + 1;
  while (end < lines.length && /^(?:\s|$)/.test(lines[end])) end++;
  return { line: start + 1, text: lines.slice(start, end).join("\n") };
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
