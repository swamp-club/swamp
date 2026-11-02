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

export interface RedactionSummary {
  readonly totalRedactions: number;
  readonly categories: ReadonlyMap<string, number>;
}

/**
 * when a redaction consumes newlines one change spans the affected block, and
 * original/redacted hold the joined multi-line text
 */
export interface RedactionLineChange {
  readonly lineNumber: number;
  readonly original: string;
  readonly redacted: string;
}

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

// leading boundary is a lookbehind, not a word boundary: _ is a word character,
// so a boundary would leave label-prefixed values (card_4111...) unredacted;
// other payload-start patterns do the same
const CREDIT_CARD_RE = /(?<![0-9A-Za-z])(?:\d[ -]*?){12,18}\d\b/g;

const SSN_RE = /(?<![0-9A-Za-z])\d{3}-\d{2}-\d{4}\b/g;

// Phone numbers: require a + prefix or at least one separator to avoid
// matching bare digit runs like batch IDs or offsets.
const PHONE_RE =
  /(?:\+\d{1,3}[\s.-]?)\(?\d{2,4}\)?[\s.-]?\d{3,4}[\s.-]?\d{3,4}\b|\(?\d{2,4}\)?[\s.-]\d{3,4}[\s.-]\d{3,4}\b/g;

const EMAIL_RE =
  /\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?)*\.[a-zA-Z]{2,}\b/g;

const AWS_KEY_RE = /(?<![0-9A-Za-z])(?:AKIA|ASIA)[A-Z0-9]{16}\b/g;

const GITHUB_TOKEN_RE =
  /(?<![0-9A-Za-z])(?:ghp|gho|ghs|ghu|ghr)_[A-Za-z0-9_]{36,}\b/g;

// lookahead instead of a word boundary after =*, since = is non-word; separator
// is spaces/tabs only so a match cannot cross a newline and consume the next
// line's token
const BEARER_RE = /\bBearer[ \t]+([A-Za-z0-9_\-.~+/]+=*)(?=\s|$)/g;

// labelled keys come in three tiers: a recognised label is evidence and buys a
// looser payload rule; an unrecognised one must earn the match from the payload
// alone

// Tier 1: labels whose formats are enumerated. Their payloads may carry
// internal separators (sk_live_<key>, sk-ant-api03-<key>).
const PREFIXED_KEY_RE =
  /\b(?:sk|pk|rk|ak|key|token|secret)[-_][a-zA-Z0-9_\-]{20,}\b/gi;

// each known label is a permanent false-positive surface, so keep the list
// short: only published formats that use a joiner and are not already covered
// by tier 1
const KNOWN_KEY_LABELS = new Set([
  "swamp",
  "glpat",
  "xoxb",
  "xoxp",
  "xapp",
  "hf",
  "shpat",
  "dop",
  "npm",
  "gsk",
  "xai",
]);

const LABELLED_KEY_RE = /\b[A-Za-z][A-Za-z0-9]{1,15}[-_][A-Za-z0-9]{20,}\b/g;

// Labels that introduce a content hash rather than a credential. Same idea as
// SAFE_HEX_KEY_RE below, which exempts a hash named by a preceding JSON key;
// extending either is a reason to look at the other.
const HASH_KEY_LABELS = new Set([
  "sha1",
  "sha256",
  "sha512",
  "md5",
  "integrity",
  "digest",
  "checksum",
  "etag",
]);

// A UUID is key material even though no segment reaches 20 characters. Only
// honoured behind a recognised label: bare UUIDs are run, trace and request
// ids, and redacting those would gut the diagnostic value of a report.
const UUID_PAYLOAD_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// one unbroken run of 20+ alphanumerics is key material; shorter runs make a
// word-structured identifier, so no word list is needed to tell them apart
const KEY_MATERIAL_RUN_RE = /[A-Za-z0-9]{20,}/;

// digits separate a random payload from a concatenated identifier like
// userlistdirectlicenses; a trailing version suffix is not evidence, so it is
// stripped before the test
const VERSION_SUFFIX_RE = /v\d+(?:[a-z]+\d+)*$/i;

function splitLabelledKey(match: string): { label: string; payload: string } {
  const joiner = match.search(/[-_]/);
  return {
    label: match.slice(0, joiner).toLowerCase(),
    payload: match.slice(joiner + 1),
  };
}

function isUnlabelledKeyPayload(payload: string): boolean {
  if (!/[A-Za-z]/.test(payload)) return false;
  return /\d/.test(payload.replace(VERSION_SUFFIX_RE, ""));
}

// only git words that name a commit mark a hex run as an object id; ref, object
// or head introduce tokens as often as ids; _ and - are not separators, so
// joined forms stay with the labelled-key rules
const GIT_ID_CONTEXT_RE =
  /(?:\b(?:commits?|sha(?:1|256)?|rev(?:ision)?|git (?:checkout|show|revert|cherry-pick|reset))(?: (?:id|sha|hash))?[ \t:=#@/"'`]{1,3}|\/(?:commits?|tree|blob)\/)$/i;

// A secret label anywhere in the same window outweighs the git word: in
// "the api token for commit <hex>" the value is the token.
const SECRET_LABEL_RE =
  /token|key|password|passwd|secret|auth|credential|signature|hmac/i;

const GIT_ID_LENGTHS = new Set([40, 64]);

// the lookbehind excludes any alphanumeric but still allows a run that starts
// right after a joiner
const LONG_HEX_RE = /(?<![0-9A-Za-z])[0-9a-fA-F]{40,}\b/g;

const LONG_BASE64_RE = /(?<![A-Za-z0-9+/])[A-Za-z0-9+/]{32,}={0,2}(?=\s|$)/g;

// a quoted value matches as a unit so the interior redacts with delimiters
// kept; an unquoted run stops before a closing quote or backtick, since a bare
// non-space run would break surrounding shell/YAML
const ENV_SECRET_RE =
  /\b([A-Z_]*(?:PASSWORD|SECRET|TOKEN|API_KEY|APIKEY|PRIVATE_KEY|ACCESS_KEY|AUTH)[A-Z_]*)=("[^"\n]*"|'[^'\n]*'|`[^`\n]*`|<[^>\n]*>|[^\s"'`]+)/gi;

// Values that contain no secret material and must survive redaction:
// already-masked values (all asterisks) and shell variable references —
// exactly the "before" side of masking-bug evidence.
const NON_SECRET_VALUE_RE = /^(?:\*+|\$\{[^}]*\})$/;

// camelCase names whose only matched keyword is AUTH are config identifiers
// (authSource), not env vars; PASSWORD, SECRET, TOKEN and KEY names are still
// redacted
const CAMEL_CASE_RE = /[a-z][A-Z]/;
const HIGH_CONFIDENCE_SECRET_RE = /PASSWORD|SECRET|TOKEN|KEY/i;

// RFC 3986 forbids whitespace and / in userinfo, so the user and password
// groups exclude them; otherwise the password can swallow text up to an
// unrelated later @
const CONNECTION_STRING_RE =
  /(\w+:\/\/)([^:/?#@\s]+):([^@/\s]+)@([^/:?#\s]+)(:\d+)?(\/[^\s?#]*)?(\?[^\s#]*)?(#\S*)?/g;

// lookbehind excludes a dot so a match cannot start inside a longer dotted run;
// lookahead refuses a quad that continues as a version (-letter or .digit) but
// still matches ranges and nip.io hosts
const IPV4_RE = /(?<![0-9A-Za-z.])(?:\d{1,3}\.){3}\d{1,3}\b(?!-[A-Za-z]|\.\d)/g;

// whole colon-joined tokens are judged by redactColonToken so an address
// redacts whatever touches it, while code paths and non-address runs are kept;
// a dotted-quad tail is judged with the token
const IPV6_RE =
  /(?<![0-9A-Za-z_])[0-9A-Za-z_]*(?::[0-9A-Za-z_]*){2,}(?:(?<=:\d{1,3})(?:\.\d{1,3}){3}(?![.\d]))?/g;

const HEX_GROUP_RE = /^[0-9A-Fa-f]{0,4}$/;

const IPV4_TAIL_RE = /^\d{1,3}(?:\.\d{1,3}){3}$/;

const HOME_PATH_RE = /(\/Users\/|\/home\/|C:\\Users\\|C:\/Users\/)([^\s/\\]+)/g;

const FQDN_RE =
  /\b(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?\.){2,}[a-zA-Z]{2,}\b/g;

// Hostnames with known internal TLDs. The lookahead refuses a match that a
// file extension follows: settings.local.json is a file name, not a host.
const INTERNAL_HOST_RE =
  /\b[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?\.(?:internal|local|lan|corp|intranet|private|home)\b(?!\.(?:json|jsonc|ya?ml|toml|ini|conf|cfg|env|xml|lock|log|txt|[cm]?[jt]sx?)\b)/g;

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

function isSafeIpv4(ip: string): boolean {
  if (ip === "0.0.0.0" || ip === "255.255.255.255") return true;
  const parts = ip.split(".");
  if (parts.length !== 4) return false;
  const [a, b, c] = parts.map(Number);
  if (a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 192 && b === 0 && c === 2) return true;
  if (a === 198 && b === 51 && c === 100) return true;
  if (a === 203 && b === 0 && c === 113) return true;
  return false;
}

function isSafeIpv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === "::1") return true;
  if (lower.startsWith("fe80:") || lower.startsWith("fe80::")) return true;
  return false;
}

// an address needs 8+ groups or a MAC run; a :: also counts unless strict,
// which applies when a word touches the run without a single colon (Foo::bar),
// where :: is as likely a code path
function isAddressLikeColonRun(run: string, strict: boolean): boolean {
  const groups = run.split(":").filter((group) => group !== "");
  // All zeros is the unspecified address, and the shape of passwd fields
  // (root:x:0:0::/root): nothing to hide.
  if (groups.every((group) => /^0+$/.test(group))) return false;
  const width = groups.length +
    (IPV4_TAIL_RE.test(groups.at(-1) ?? "") ? 1 : 0);
  if (width >= 8) return true;
  if (!strict && run.includes("::")) return true;
  let twoHexRun = 0;
  for (const group of groups) {
    twoHexRun = group.length === 2 ? twoHexRun + 1 : 0;
    if (twoHexRun === 6) return true;
  }
  return false;
}

// hash labels in joined form (sha512-<hash>); SAFE_HEX_KEY_RE covers the
// JSON-key form, so a lockfile integrity string survives both
const HASH_LABEL_PREFIX_RE =
  /(?:sha1|sha256|sha512|md5|integrity|digest|checksum|etag)[-_]$/i;

const SAFE_HEX_KEY_RE =
  /(?:"|\\")?(?:checksum|sha256|sha1|sha512|digest|hash|contentHash|etag|md5)(?:"|\\")?[\s]*:[\s]*(?:"|\\")?$/i;

// used to tell real hostnames from dotted code identifiers like includes, get,
// env or length, which are not TLDs and get skipped
const COMMON_TLDS = new Set([
  "ac",
  "ad",
  "ae",
  "af",
  "ag",
  "ai",
  "al",
  "am",
  "ao",
  "app",
  "ar",
  "as",
  "at",
  "au",
  "az",
  "ba",
  "be",
  "bg",
  "bh",
  "bi",
  "biz",
  "bj",
  "bn",
  "bo",
  "br",
  "bs",
  "bt",
  "bw",
  "by",
  "bz",
  "ca",
  "cat",
  "cc",
  "cd",
  "cf",
  "cg",
  "ch",
  "ci",
  "ck",
  "cl",
  "cloud",
  "cm",
  "cn",
  "co",
  "com",
  "cr",
  "cu",
  "cv",
  "cx",
  "cy",
  "cz",
  "de",
  "dev",
  "dj",
  "dk",
  "dm",
  "do",
  "dz",
  "ec",
  "edu",
  "ee",
  "eg",
  "er",
  "es",
  "et",
  "eu",
  "fi",
  "fj",
  "fk",
  "fm",
  "fo",
  "fr",
  "ga",
  "gd",
  "ge",
  "gg",
  "gh",
  "gi",
  "gl",
  "gm",
  "gn",
  "gov",
  "gp",
  "gq",
  "gr",
  "gs",
  "gt",
  "gu",
  "gw",
  "gy",
  "hk",
  "hm",
  "hn",
  "hr",
  "ht",
  "hu",
  "id",
  "ie",
  "il",
  "im",
  "in",
  "info",
  "int",
  "io",
  "iq",
  "ir",
  "is",
  "it",
  "je",
  "jm",
  "jo",
  "jobs",
  "jp",
  "ke",
  "kg",
  "kh",
  "ki",
  "km",
  "kn",
  "kp",
  "kr",
  "kw",
  "ky",
  "kz",
  "la",
  "land",
  "lb",
  "lc",
  "li",
  "lk",
  "lr",
  "ls",
  "lt",
  "lu",
  "lv",
  "ly",
  "ma",
  "mc",
  "md",
  "me",
  "mg",
  "mh",
  "mil",
  "mk",
  "ml",
  "mm",
  "mn",
  "mo",
  "mp",
  "mq",
  "mr",
  "ms",
  "mt",
  "mu",
  "museum",
  "mv",
  "mw",
  "mx",
  "my",
  "mz",
  "na",
  "name",
  "nc",
  "ne",
  "net",
  "nf",
  "ng",
  "ni",
  "nl",
  "no",
  "np",
  "nr",
  "nu",
  "nz",
  "om",
  "onion",
  "org",
  "pa",
  "page",
  "pe",
  "pf",
  "pg",
  "ph",
  "pk",
  "pl",
  "pm",
  "pn",
  "pr",
  "pro",
  "ps",
  "pt",
  "pw",
  "py",
  "qa",
  "re",
  "ro",
  "rs",
  "ru",
  "run",
  "rw",
  "sa",
  "sb",
  "sc",
  "sd",
  "se",
  "sg",
  "sh",
  "si",
  "site",
  "sk",
  "sl",
  "sm",
  "sn",
  "so",
  "sr",
  "ss",
  "st",
  "su",
  "sv",
  "sx",
  "sy",
  "sz",
  "tc",
  "td",
  "tel",
  "tf",
  "tg",
  "th",
  "tj",
  "tk",
  "tl",
  "tm",
  "tn",
  "to",
  "today",
  "tr",
  "tt",
  "tv",
  "tw",
  "tz",
  "ua",
  "ug",
  "uk",
  "us",
  "uy",
  "uz",
  "va",
  "vc",
  "ve",
  "vg",
  "vi",
  "vn",
  "vu",
  "website",
  "wf",
  "ws",
  "xxx",
  "ye",
  "yt",
  "za",
  "zm",
  "zw",
]);

// TLDs that double as property names read as code paths inside markdown code
// unless context marks a host; real-infrastructure TLDs (it, in, io, com, id)
// are absent so those hosts stay redacted
const CODE_IDENTIFIER_TLDS = new Set([
  "info",
  "jobs",
  "name",
  "page",
  "run",
  "site",
]);

// context only a host has: a scheme or userinfo before, a port or path after;
// only adjacent characters are checked, so a host after a keyword (host=, ssh)
// inside code reads as a code path
const HOST_PREFIX_RE = /(?:\/\/|@)$/;
const HOST_SUFFIX_RE = /^(?::\d|\/)/;

// A backtick fence's info string cannot contain a backtick (CommonMark).
const FENCE_OPEN_RE = /^ {0,3}(?:(`{3,})(?!.*`)|(~{3,}))/;

interface CodeRange {
  start: number;
  end: number;
}

// fenced blocks first, then inline spans (same-length backtick runs on one
// line) outside fences; unclosed fences and spans are prose; indented code
// blocks are not recognised
function findCodeRanges(text: string): CodeRange[] {
  const ranges: CodeRange[] = [];
  const lines = text.split("\n");
  const starts: number[] = [];
  let pos = 0;
  for (const line of lines) {
    starts.push(pos);
    pos += line.length + 1;
  }

  const inFence = new Array<boolean>(lines.length).fill(false);
  for (let i = 0; i < lines.length; i++) {
    const open = FENCE_OPEN_RE.exec(lines[i]);
    if (!open) continue;
    const fence = open[1] ?? open[2];
    // fence[0] is a backtick or tilde, neither of which needs escaping.
    const close = new RegExp(`^ {0,3}${fence[0]}{${fence.length},}\\s*$`);
    let closed = false;
    for (let j = i + 1; j < lines.length; j++) {
      if (!close.test(lines[j])) continue;
      ranges.push({
        start: starts[i],
        end: starts[j] + lines[j].length,
      });
      for (let k = i; k <= j; k++) inFence[k] = true;
      closed = true;
      i = j;
      break;
    }
    // an unclosed fence runs to the end of the text, so stop scanning rather
    // than rescan from every later opener; inline spans on later lines are
    // still found
    if (!closed) break;
  }

  for (let i = 0; i < lines.length; i++) {
    if (inFence[i]) continue;
    // A backslash-escaped backtick is literal text, not a span delimiter.
    const runs = [...lines[i].matchAll(/(?<!\\)`+/g)];
    for (let r = 0; r < runs.length; r++) {
      const open = runs[r];
      const close = runs.findIndex((run, idx) =>
        idx > r && run[0].length === open[0].length
      );
      if (close === -1) continue;
      const closeRun = runs[close];
      ranges.push({
        start: starts[i] + open.index,
        end: starts[i] + closeRun.index + closeRun[0].length,
      });
      r = close;
    }
  }
  return ranges;
}

function isInsideCode(
  ranges: CodeRange[],
  offset: number,
  length: number,
): boolean {
  return ranges.some((range) =>
    offset >= range.start && offset + length <= range.end
  );
}

/**
 * splits a colon token into word parts (labels) and hex-group runs, each judged
 * alone; a word joined by one colon stays whole; a run glued to a neighbouring
 * word is judged strictly so a full address is caught
 */
function redactColonToken(
  token: string,
  placeholders: PlaceholderMap,
  count: (category: string) => void,
): string {
  const parts = token.split(":");
  const n = parts.length;
  const isGroup = parts.map((part, k) =>
    HEX_GROUP_RE.test(part) || (k === n - 1 && IPV4_TAIL_RE.test(part))
  );
  // Output text per part (null once folded into a placeholder), and whether
  // the colon before a part is dropped because a placeholder spans it.
  const pieces: Array<string | null> = [...parts];
  const joinedToPrevious: boolean[] = parts.map(() => false);

  const judge = (candidate: string, strict: boolean): string | null => {
    const lead = /^(?::(?!:)|:::)/.test(candidate) ? ":" : "";
    const trail = /(?:[^:]:|:::)$/.test(candidate) ? ":" : "";
    const run = candidate.slice(lead.length, candidate.length - trail.length);
    if (!isAddressLikeColonRun(run, strict)) return null;
    if (isSafeIpv6(run)) return candidate;
    count("IP address");
    return `${lead}${placeholders.get("IP", run)}${trail}`;
  };

  let i = 0;
  while (i < n) {
    if (!isGroup[i]) {
      i++;
      continue;
    }
    let j = i;
    while (j + 1 < n && isGroup[j + 1]) j++;
    const hasLeft = i > 0;
    const hasRight = j < n - 1;
    const run = parts.slice(i, j + 1);
    const touchesLeftWord = hasLeft && run[0] === "" &&
      (run.length === 1 || run[1] !== "");
    const touchesWord = touchesLeftWord ||
      (hasRight && run[run.length - 1] === "" &&
        (run.length === 1 || run[run.length - 2] !== ""));
    const left = hasLeft ? pieces[i - 1] ?? "" : "";
    const right = hasRight ? pieces[j + 1] ?? "" : "";
    const glueLeft = left.match(/(?<![0-9A-Fa-f])[0-9A-Fa-f]{1,4}$/)?.[0] ?? "";
    const glueRight = right.match(/^[0-9A-Fa-f]{1,4}(?![0-9A-Fa-f])/)?.[0] ??
      "";

    const own = judge(run.join(":"), touchesWord);
    // a unit stuck on an address end (2001:db8::1ms) starts with its last
    // group, so a non-address run is re-judged with it; counts only when two
    // groups join by one colon, which code paths never do
    const runWithUnit = [...run, glueRight].join(":");
    const unitOnEnd = own === null && glueRight !== "" && !touchesLeftWord &&
      /[0-9A-Fa-f]:[0-9A-Fa-f]/.test(runWithUnit);
    const withUnit = unitOnEnd ? judge(runWithUnit, false) : null;
    // Otherwise, strictly, with the groups glued on either side, so only a
    // full address or MAC counts once those are added.
    const full = own === null && withUnit === null && (glueLeft || glueRight)
      ? judge(
        [
          ...(glueLeft ? [glueLeft] : []),
          ...run,
          ...(glueRight ? [glueRight] : []),
        ].join(":"),
        true,
      )
      : null;
    const replacement = own ?? withUnit ?? full;
    if (replacement !== null) {
      pieces[i] = replacement;
      for (let k = i + 1; k <= j; k++) pieces[k] = null;
      if (full !== null && glueLeft) {
        pieces[i - 1] = left.slice(0, left.length - glueLeft.length);
        joinedToPrevious[i] = true;
      }
      if ((withUnit !== null || full !== null) && glueRight) {
        pieces[j + 1] = right.slice(glueRight.length);
        joinedToPrevious[j + 1] = true;
      }
    }
    i = j + 1;
  }

  let out = "";
  for (let k = 0; k < n; k++) {
    const piece = pieces[k];
    if (piece === null) continue;
    if (k > 0 && !joinedToPrevious[k]) out += ":";
    out += piece;
  }
  return out;
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

  // quoted values redact inside their delimiters; masked and variable-reference
  // values pass through; distinct values get distinct placeholders so
  // before/after evidence keeps its contrast
  result = result.replace(
    ENV_SECRET_RE,
    (match, name: string, value: string) => {
      const first = value[0];
      if (first === "<") return match;
      const quote = first === '"' || first === "'" || first === "`"
        ? first
        : "";
      const inner = quote ? value.slice(1, -1) : value;
      if (inner.length === 0 || NON_SECRET_VALUE_RE.test(inner)) return match;
      if (CAMEL_CASE_RE.test(name) && !HIGH_CONFIDENCE_SECRET_RE.test(name)) {
        return match;
      }
      count("secret");
      const placeholder = placeholders.get("REDACTED-SECRET", inner);
      return `${name}=${quote}${placeholder}${quote}`;
    },
  );

  result = result.replace(AWS_KEY_RE, (match) => {
    count("secret");
    return placeholders.get("REDACTED-SECRET", match);
  });

  result = result.replace(GITHUB_TOKEN_RE, (match) => {
    count("secret");
    return placeholders.get("REDACTED-SECRET", match);
  });

  result = result.replace(BEARER_RE, (_match, token: string) => {
    count("secret");
    return `Bearer ${placeholders.get("REDACTED-SECRET", token)}`;
  });

  // the payload must carry key material: an enumerated label before a
  // word-structured payload is an identifier like KEY_ALGORITHM_UNSPECIFIED,
  // not a credential
  result = result.replace(PREFIXED_KEY_RE, (match) => {
    const { payload } = splitLabelledKey(match);
    if (!KEY_MATERIAL_RUN_RE.test(payload) && !UUID_PAYLOAD_RE.test(payload)) {
      return match;
    }
    count("secret");
    return placeholders.get("REDACTED-SECRET", match);
  });

  result = result.replace(EMAIL_RE, () => {
    count("email");
    return "[REDACTED-EMAIL]";
  });

  // runs after the email pass on purpose: before it, a long local part
  // (user_<long>@corp.com) becomes a placeholder, the email matcher misses the
  // address, and the domain survives
  result = result.replace(LABELLED_KEY_RE, (match) => {
    const { label, payload } = splitLabelledKey(match);
    if (HASH_KEY_LABELS.has(label)) return match;
    if (!KNOWN_KEY_LABELS.has(label) && !isUnlabelledKeyPayload(payload)) {
      return match;
    }
    count("secret");
    return placeholders.get("REDACTED-SECRET", match);
  });

  result = result.replace(SSN_RE, () => {
    count("national ID");
    return "[REDACTED-ID]";
  });

  result = result.replace(CREDIT_CARD_RE, (match) => {
    const digits = match.replace(/[\s-]/g, "");
    if (digits.length >= 13 && digits.length <= 19 && isLuhnValid(digits)) {
      count("credit card");
      return "[REDACTED-CC]";
    }
    return match;
  });

  result = result.replace(PHONE_RE, (match) => {
    if (!/[+().-]/.test(match)) return match;
    const digits = match.replace(/\D/g, "");
    if (digits.length >= 7 && digits.length <= 15) {
      count("phone number");
      return "[REDACTED-PHONE]";
    }
    return match;
  });

  // reconstruct positionally to avoid replacing the wrong substring when the
  // username equals a path component (/home/home)
  result = result.replace(
    HOME_PATH_RE,
    (_match, prefix: string, _username: string) => {
      count("home directory path");
      return `${prefix}[REDACTED]`;
    },
  );

  // IPv6 runs before IPv4 to avoid partial matches on mapped addresses
  result = result.replace(
    IPV6_RE,
    (token: string) => redactColonToken(token, placeholders, count),
  );

  // a group above 255 means the quad is not an address; the regex already
  // refuses version-like quads such as 1.23.4
  result = result.replace(IPV4_RE, (match) => {
    if (isSafeIpv4(match)) return match;
    if (match.split(".").some((part) => Number(part) > 255)) return match;
    count("IP address");
    return placeholders.get("IP", match);
  });

  result = result.replace(INTERNAL_HOST_RE, (match) => {
    if (isPublicHost(match)) return match;
    count("hostname");
    return placeholders.get("HOST", match);
  });

  // a code path inside markdown code whose last label is identifier-like is not
  // a host
  const codeRanges = findCodeRanges(result);
  result = result.replace(
    FQDN_RE,
    (match: string, offset: number, source: string) => {
      if (isPublicHost(match)) return match;
      if (isVersionString(match)) return match;
      if (source[offset + match.length] === "(") return match;
      const tld = match.slice(match.lastIndexOf(".") + 1).toLowerCase();
      if (!COMMON_TLDS.has(tld)) return match;
      if (
        CODE_IDENTIFIER_TLDS.has(tld) &&
        isInsideCode(codeRanges, offset, match.length) &&
        !HOST_PREFIX_RE.test(source.slice(Math.max(0, offset - 2), offset)) &&
        !HOST_SUFFIX_RE.test(
          source.slice(offset + match.length, offset + match.length + 2),
        )
      ) {
        return match;
      }
      count("hostname");
      return placeholders.get("HOST", match);
    },
  );

  result = result.replace(
    LONG_HEX_RE,
    (match: string, offset: number, source: string) => {
      const preceding = source.slice(Math.max(0, offset - 40), offset);
      if (SAFE_HEX_KEY_RE.test(preceding)) return match;
      if (HASH_LABEL_PREFIX_RE.test(preceding)) return match;
      if (
        GIT_ID_LENGTHS.has(match.length) &&
        GIT_ID_CONTEXT_RE.test(preceding) && !SECRET_LABEL_RE.test(preceding)
      ) {
        return match;
      }
      count("secret");
      return placeholders.get("REDACTED-SECRET", match);
    },
  );

  result = result.replace(
    LONG_BASE64_RE,
    (match: string, offset: number, source: string) => {
      if (
        HASH_LABEL_PREFIX_RE.test(
          source.slice(Math.max(0, offset - 16), offset),
        )
      ) {
        return match;
      }
      if (/[a-z]/.test(match) && /[A-Z]/.test(match)) {
        count("secret");
        return placeholders.get("REDACTED-SECRET", match);
      }
      return match;
    },
  );

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
