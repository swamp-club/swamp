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
 * Tracks placeholder assignments for a single redaction pass so the same
 * raw value always maps to the same placeholder within one issue.
 */
class PlaceholderMap {
  private readonly maps = new Map<string, Map<string, string>>();

  get(category: string, raw: string): string {
    let catMap = this.maps.get(category);
    if (!catMap) {
      catMap = new Map<string, string>();
      this.maps.set(category, catMap);
    }
    const existing = catMap.get(raw);
    if (existing) return existing;
    const index = catMap.size + 1;
    const placeholder = `[${category}-${index}]`;
    catMap.set(raw, placeholder);
    return placeholder;
  }
}

/** Summary of what was redacted, for user notification. */
export interface RedactionSummary {
  readonly totalRedactions: number;
  readonly categories: ReadonlyMap<string, number>;
}

/**
 * A single line-level change produced by redaction, so the reporter can
 * see exactly what was altered before the content leaves their machine.
 * When a redaction consumes newlines, one change spans the affected block
 * and `original`/`redacted` hold the joined multi-line text.
 */
export interface RedactionLineChange {
  readonly lineNumber: number;
  readonly original: string;
  readonly redacted: string;
}

/** Result of redacting issue content. */
export interface RedactionResult {
  readonly text: string;
  readonly summary: RedactionSummary;
  readonly changes: readonly RedactionLineChange[];
}

const PUBLIC_HOST_ALLOWLIST = new Set([
  "github.com",
  "gitlab.com",
  "bitbucket.org",
  "npmjs.org",
  "registry.npmjs.org",
  "npmjs.com",
  "deno.land",
  "jsr.io",
  "swamp-club.com",
  "api.swamp-club.com",
  "swamp.dev",
  "localhost",
  "example.com",
  "example.org",
  "example.net",
]);

// --- Pattern definitions ---

// Credit card: 13-19 digit sequences with optional separators
const CREDIT_CARD_RE = /\b(?:\d[ -]*?){12,18}\d\b/g;

// SSN / national ID: XXX-XX-XXXX
const SSN_RE = /\b\d{3}-\d{2}-\d{4}\b/g;

// Phone numbers: require a + prefix or at least one separator to avoid
// matching bare digit runs like batch IDs or offsets.
const PHONE_RE =
  /(?:\+\d{1,3}[\s.-]?)\(?\d{2,4}\)?[\s.-]?\d{3,4}[\s.-]?\d{3,4}\b|\(?\d{2,4}\)?[\s.-]\d{3,4}[\s.-]\d{3,4}\b/g;

// Email addresses
const EMAIL_RE =
  /\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?)*\.[a-zA-Z]{2,}\b/g;

// AWS access key IDs
const AWS_KEY_RE = /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g;

// GitHub tokens
const GITHUB_TOKEN_RE = /\b(?:ghp|gho|ghs|ghu|ghr)_[A-Za-z0-9_]{36,}\b/g;

// Generic API keys / bearer tokens: long base64-ish strings with a prefix.
// Use lookahead instead of \b after =* since = is non-word and \b fails
// between two non-word characters (e.g. "==" followed by space). The
// separator is spaces/tabs only — \s would let the match cross a newline
// and consume the first token of the following line.
const BEARER_RE = /\bBearer[ \t]+([A-Za-z0-9_\-.~+/]+=*)(?=\s|$)/g;
const PREFIXED_KEY_RE =
  /\b(?:sk|pk|rk|ak|key|token|secret)[-_][a-zA-Z0-9_\-]{20,}\b/gi;

// Generic long hex strings (40+ chars, like SHA tokens / API keys)
const LONG_HEX_RE = /\b[0-9a-fA-F]{40,}\b/g;

// Generic long base64 strings (32+ chars, often tokens/secrets).
// Same =* lookahead fix as BEARER_RE.
const LONG_BASE64_RE = /\b[A-Za-z0-9+/]{32,}={0,2}(?=\s|$)/g;

// env-var style secrets: VAR_NAME=value where name contains sensitive
// keywords. The value is either an explicitly quoted span (matched as a
// unit so the interior can be redacted with the delimiters preserved) or
// an unquoted run that stops before a closing quote/backtick — a bare \S+
// would consume the delimiter and break surrounding shell/YAML syntax.
const ENV_SECRET_RE =
  /\b([A-Z_]*(?:PASSWORD|SECRET|TOKEN|API_KEY|APIKEY|PRIVATE_KEY|ACCESS_KEY|AUTH)[A-Z_]*)=("[^"\n]*"|'[^'\n]*'|`[^`\n]*`|[^\s"'`]+)/gi;

// Values that contain no secret material and must survive redaction:
// already-masked values (all asterisks) and shell variable references —
// exactly the "before" side of masking-bug evidence.
const NON_SECRET_VALUE_RE = /^(?:\*+|\$\{[^}]*\})$/;

// Connection strings with credentials. RFC 3986 forbids whitespace and "/"
// in the userinfo component, so the user and password groups exclude them —
// otherwise the password group can swallow everything (across lines) up to
// an unrelated later "@", e.g. a ws://host:port URL followed by an
// @scope/package mention.
const CONNECTION_STRING_RE =
  /(\w+:\/\/)([^:/?#@\s]+):([^@/\s]+)@([^/:?#\s]+)(:\d+)?(\/[^\s?#]*)?(\?[^\s#]*)?(#\S*)?/g;

// IPv4
const IPV4_RE = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;

// IPv6 (simplified: at least two colons in a hex group sequence)
const IPV6_RE =
  /\b(?:[0-9a-fA-F]{1,4}:){2,7}[0-9a-fA-F]{1,4}\b|::(?:[0-9a-fA-F]{1,4}:){0,5}[0-9a-fA-F]{1,4}\b|(?:[0-9a-fA-F]{1,4}:){1,6}::[0-9a-fA-F]{0,4}\b/g;

// Home directory paths with usernames — captures the prefix and username
// separately so we can reconstruct positionally.
const HOME_PATH_RE = /(\/Users\/|\/home\/|C:\\Users\\|C:\/Users\/)([^\s/\\]+)/g;

// FQDNs: at least 2 dots, not a version number, not in the allowlist
const FQDN_RE =
  /\b(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?\.){2,}[a-zA-Z]{2,}\b/g;

// Hostnames with known internal TLDs
const INTERNAL_HOST_RE =
  /\b[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?\.(?:internal|local|lan|corp|intranet|private|home)\b/g;

function isLuhnValid(digits: string): boolean {
  let sum = 0;
  let alternate = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = parseInt(digits[i], 10);
    if (alternate) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alternate = !alternate;
  }
  return sum % 10 === 0;
}

function isVersionString(s: string): boolean {
  return /^\d+\.\d+\.\d+(?:\.\d+)?$/.test(s);
}

function isPublicHost(host: string): boolean {
  const lower = host.toLowerCase();
  if (PUBLIC_HOST_ALLOWLIST.has(lower)) return true;
  for (const allowed of PUBLIC_HOST_ALLOWLIST) {
    if (lower.endsWith("." + allowed)) return true;
  }
  return false;
}

function applyRedactions(
  text: string,
  placeholders: PlaceholderMap,
  counts: Map<string, number>,
): string {
  let result = text;

  function count(category: string): void {
    counts.set(category, (counts.get(category) ?? 0) + 1);
  }

  // Order matters: more specific patterns first, then broader ones.

  // 1. Connection strings (before general URL/host matching)
  result = result.replace(
    CONNECTION_STRING_RE,
    (
      _match,
      scheme: string,
      _user: string,
      _password: string,
      host: string,
      port: string | undefined,
      path: string | undefined,
      query: string | undefined,
      fragment: string | undefined,
    ) => {
      count("secret");
      count("hostname");
      const hostPlaceholder = placeholders.get("HOST", host);
      return `${scheme}[REDACTED-USER]:***@${hostPlaceholder}${port ?? ""}${
        path ?? ""
      }${query ?? ""}${fragment ?? ""}`;
    },
  );

  // 2. Env-var style secrets. Quoted values are redacted inside their
  //    delimiters; masked (***) and ${VAR} values pass through untouched.
  //    Distinct values get distinct indexed placeholders so before/after
  //    evidence (e.g. a masked-vs-unmasked comparison table) keeps its
  //    contrast instead of collapsing to identical rows.
  result = result.replace(
    ENV_SECRET_RE,
    (match, name: string, value: string) => {
      const first = value[0];
      const quote = first === '"' || first === "'" || first === "`"
        ? first
        : "";
      const inner = quote ? value.slice(1, -1) : value;
      if (inner.length === 0 || NON_SECRET_VALUE_RE.test(inner)) return match;
      count("secret");
      const placeholder = placeholders.get("REDACTED-SECRET", inner);
      return `${name}=${quote}${placeholder}${quote}`;
    },
  );

  // 3. AWS keys
  result = result.replace(AWS_KEY_RE, (match) => {
    count("secret");
    return placeholders.get("REDACTED-SECRET", match);
  });

  // 4. GitHub tokens
  result = result.replace(GITHUB_TOKEN_RE, (match) => {
    count("secret");
    return placeholders.get("REDACTED-SECRET", match);
  });

  // 5. Bearer tokens
  result = result.replace(BEARER_RE, (_match, token: string) => {
    count("secret");
    return `Bearer ${placeholders.get("REDACTED-SECRET", token)}`;
  });

  // 6. Prefixed API keys (sk_live_..., token-..., etc.)
  result = result.replace(PREFIXED_KEY_RE, (match) => {
    count("secret");
    return placeholders.get("REDACTED-SECRET", match);
  });

  // 7. Email addresses
  result = result.replace(EMAIL_RE, () => {
    count("email");
    return "[REDACTED-EMAIL]";
  });

  // 8. SSNs
  result = result.replace(SSN_RE, () => {
    count("national ID");
    return "[REDACTED-ID]";
  });

  // 9. Credit cards (Luhn-validated to reduce false positives)
  result = result.replace(CREDIT_CARD_RE, (match) => {
    const digits = match.replace(/[\s-]/g, "");
    if (digits.length >= 13 && digits.length <= 19 && isLuhnValid(digits)) {
      count("credit card");
      return "[REDACTED-CC]";
    }
    return match;
  });

  // 10. Phone numbers
  result = result.replace(PHONE_RE, (match) => {
    const digits = match.replace(/\D/g, "");
    if (digits.length >= 7 && digits.length <= 15) {
      count("phone number");
      return "[REDACTED-PHONE]";
    }
    return match;
  });

  // 11. Home directory usernames — reconstruct positionally to avoid
  //     wrong-substring replacement when username equals a path component
  //     (e.g. /home/home).
  result = result.replace(
    HOME_PATH_RE,
    (_match, prefix: string, _username: string) => {
      count("home directory path");
      return `${prefix}[REDACTED]`;
    },
  );

  // 12. IPv6 (before IPv4 to avoid partial matches on mapped addresses)
  result = result.replace(IPV6_RE, (match) => {
    count("IP address");
    return placeholders.get("IP", match);
  });

  // 13. IPv4 (the regex requires exactly 4 octets, so 3-segment version
  //     strings like "1.23.4" never match — no version guard needed)
  result = result.replace(IPV4_RE, (match) => {
    count("IP address");
    return placeholders.get("IP", match);
  });

  // 14. Internal hostnames (.internal, .local, .lan, .corp, etc.)
  result = result.replace(INTERNAL_HOST_RE, (match) => {
    if (isPublicHost(match)) return match;
    count("hostname");
    return placeholders.get("HOST", match);
  });

  // 15. FQDNs (3+ segments)
  result = result.replace(FQDN_RE, (match) => {
    if (isPublicHost(match)) return match;
    if (isVersionString(match)) return match;
    count("hostname");
    return placeholders.get("HOST", match);
  });

  // 16. Long hex strings (likely tokens/hashes — after all specific patterns)
  result = result.replace(LONG_HEX_RE, (match) => {
    count("secret");
    return placeholders.get("REDACTED-SECRET", match);
  });

  // 17. Long base64 strings
  result = result.replace(LONG_BASE64_RE, (match) => {
    if (/[a-z]/.test(match) && /[A-Z]/.test(match)) {
      count("secret");
      return placeholders.get("REDACTED-SECRET", match);
    }
    return match;
  });

  return result;
}

function diffLines(
  original: string,
  redacted: string,
): RedactionLineChange[] {
  if (original === redacted) return [];
  const before = original.split("\n");
  const after = redacted.split("\n");
  if (before.length === after.length) {
    const changes: RedactionLineChange[] = [];
    for (let i = 0; i < before.length; i++) {
      if (before[i] !== after[i]) {
        changes.push({
          lineNumber: i + 1,
          original: before[i],
          redacted: after[i],
        });
      }
    }
    return changes;
  }
  // Line counts differ (a redaction consumed newlines): align matching
  // head/tail lines and report the middle as a single block change.
  let head = 0;
  while (
    head < before.length && head < after.length && before[head] === after[head]
  ) {
    head++;
  }
  let tail = 0;
  while (
    tail < before.length - head && tail < after.length - head &&
    before[before.length - 1 - tail] === after[after.length - 1 - tail]
  ) {
    tail++;
  }
  return [{
    lineNumber: head + 1,
    original: before.slice(head, before.length - tail).join("\n"),
    redacted: after.slice(head, after.length - tail).join("\n"),
  }];
}

function buildSummary(counts: Map<string, number>): RedactionSummary {
  let totalRedactions = 0;
  for (const c of counts.values()) {
    totalRedactions += c;
  }
  return { totalRedactions, categories: counts };
}

/**
 * Redacts sensitive and identifying information from a single text string.
 *
 * Produces stable placeholders ([HOST-1], [IP-1], etc.) so the same raw
 * value maps to the same placeholder throughout the text, preserving
 * diagnostic structure without leaking identifying details.
 */
export function redactIssueContent(text: string): RedactionResult {
  const placeholders = new PlaceholderMap();
  const counts = new Map<string, number>();
  const redacted = applyRedactions(text, placeholders, counts);
  return {
    text: redacted,
    summary: buildSummary(counts),
    changes: diffLines(text, redacted),
  };
}

/**
 * Redacts title and body together, sharing a single placeholder map so the
 * same raw value (e.g. an IP) gets the same placeholder in both fields.
 */
export function redactIssueTitleAndBody(
  title: string,
  body: string,
): {
  title: RedactionResult;
  body: RedactionResult;
  summary: RedactionSummary;
} {
  const placeholders = new PlaceholderMap();
  const counts = new Map<string, number>();

  const titleText = applyRedactions(title, placeholders, counts);
  const titleSnapshot = new Map(counts);

  const bodyText = applyRedactions(body, placeholders, counts);

  const titleCounts = new Map<string, number>();
  for (const [cat, n] of titleSnapshot) {
    titleCounts.set(cat, n);
  }
  const bodyCounts = new Map<string, number>();
  for (const [cat, n] of counts) {
    bodyCounts.set(cat, n - (titleSnapshot.get(cat) ?? 0));
  }

  return {
    title: {
      text: titleText,
      summary: buildSummary(titleCounts),
      changes: diffLines(title, titleText),
    },
    body: {
      text: bodyText,
      summary: buildSummary(bodyCounts),
      changes: diffLines(body, bodyText),
    },
    summary: buildSummary(counts),
  };
}

function pluralize(word: string, count: number): string {
  if (count === 1) return word;
  if (word.endsWith("s") || word.endsWith("x")) return word + "es";
  return word + "s";
}

/** Formats the redaction summary into a human-readable log line. */
export function formatRedactionSummary(summary: RedactionSummary): string {
  if (summary.totalRedactions === 0) return "";
  const parts: string[] = [];
  for (const [category, count] of summary.categories) {
    parts.push(`${count} ${pluralize(category, count)}`);
  }
  return `Redacted ${parts.join(", ")} from issue content.`;
}

const MAX_DETAIL_LENGTH = 160;

function inlineTruncate(text: string): string {
  const flat = text.replaceAll("\n", "\\n");
  if (flat.length <= MAX_DETAIL_LENGTH) return flat;
  return flat.slice(0, MAX_DETAIL_LENGTH - 1) + "…";
}

/**
 * Formats per-line redaction changes into human-readable detail lines
 * ("line N: <original> -> <redacted>"), so the reporter can verify their
 * evidence survived redaction. `label` prefixes the location (e.g. "title").
 */
export function formatRedactionDetails(
  changes: readonly RedactionLineChange[],
  label?: string,
): string[] {
  const prefix = label ? `${label} line` : "line";
  return changes.map((change) =>
    `${prefix} ${change.lineNumber}: ${inlineTruncate(change.original)} -> ${
      inlineTruncate(change.redacted)
    }`
  );
}
