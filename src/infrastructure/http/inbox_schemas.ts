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
 * responses are untrusted: text is stripped of terminal escapes here so no
 * later consumer sees the raw form
 */

import { z } from "zod";
import { sanitizeFieldText } from "../../domain/vaults/vault_config_fields.ts";
import { getSwampLogger } from "../logging/logger.ts";

const logger = getSwampLogger(["inbox", "schemas"]);

export const MAX_INBOX_TITLE_LENGTH = 120;
export const MAX_INBOX_BODY_BYTES = 8 * 1024;
export const MAX_INBOX_KIND_LENGTH = 40;
export const MAX_INBOX_ACTION_LABEL_LENGTH = 40;
export const MAX_INBOX_ACTION_COMMAND_LENGTH = 200;

export const INBOX_REQUIRES_USER = "inbox_requires_user";

export interface InboxSummary {
  readonly unread: number;
  readonly newestId: string | null;
  readonly newestAt: string | null;
  /**
   * The server's value, unclamped. The poller enforces the 900-second floor.
   */
  readonly pollAfterSeconds: number;
}

/** A command a message suggests; always a `swamp` command. */
export interface InboxAction {
  readonly label: string;
  readonly command: string;
}

export interface InboxMessage {
  /** Upper-case ULID, so "newer than" is a string compare. */
  readonly id: string;
  /** Any string, so kinds added later still parse. */
  readonly kind: string;
  readonly title: string;
  /** Markdown; newlines and tabs are its only control characters. */
  readonly body: string;
  readonly createdAt: string;
  readonly link?: string;
  readonly action?: InboxAction;
  readonly readAt: string | null;
}

export interface InboxMessagePage {
  readonly messages: InboxMessage[];
  /**
   * How many entries on the page broke the contract and were left out, so a
   * server that drifts from it shows up instead of losing messages silently.
   */
  readonly dropped: number;
  /**
   * The oldest listed message's id, upper-case ULID: pass as `before` to fetch
   * the next page. Null on the last page.
   */
  readonly nextCursor: string | null;
}

export type InboxReadStatus = "unread" | "all";

export interface InboxListOptions {
  readonly status?: InboxReadStatus;
  readonly limit?: number;
  readonly before?: string;
}

/**
 * A classified `/api/inbox/summary` answer. The background poll is best
 * effort, so every failure is a case here rather than a throw.
 */
export type InboxSummaryResult =
  | {
    readonly kind: "ok";
    readonly summary: InboxSummary;
    readonly etag: string | null;
  }
  | { readonly kind: "not_modified" }
  | { readonly kind: "unsupported" }
  | { readonly kind: "unavailable" }
  | { readonly kind: "rejected" }
  | { readonly kind: "backoff"; readonly retryAfterSeconds?: number }
  | { readonly kind: "failed"; readonly reason: string };

// deno-lint-ignore no-control-regex
const ANSI_OSC_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g;
// deno-lint-ignore no-control-regex
const ANSI_CSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]/g;
// Every C0 and C1 control except tab (\x09) and newline (\x0a).
// deno-lint-ignore no-control-regex
const BODY_CONTROL_RE = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;
/**
 * Bidi controls and zero-width characters. They print nothing, yet can
 * reorder the text around them or hide a difference between two strings.
 */
const INVISIBLE_RE =
  /[\u061c\u200b-\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/g;
const HAS_INVISIBLE_RE = new RegExp(INVISIBLE_RE.source);
/**
 * the same less the zero-width non-joiner and joiner: prose needs them for
 * emoji sequences and Persian and Indic scripts, and they cannot reorder text;
 * body and title only
 */
export const PROSE_INVISIBLE_RE =
  /[\u061c\u200b\u200e\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/g;
const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/i;

export function isInboxMessageId(text: string): boolean {
  return ULID_RE.test(text);
}

export function sanitizeInboxBody(text: string): string {
  return text
    .replace(ANSI_OSC_RE, "")
    .replace(ANSI_CSI_RE, "")
    .replace(/\r\n?/g, "\n")
    .replace(BODY_CONTROL_RE, "")
    .replace(PROSE_INVISIBLE_RE, "");
}

/**
 * cut on code points so a character outside the BMP is never split into half a
 * surrogate pair
 */
export function sanitizeLine(
  text: string,
  maxLength: number,
  invisible: RegExp = INVISIBLE_RE,
): string {
  const cleaned = sanitizeFieldText(
    text.replace(invisible, ""),
    Number.MAX_SAFE_INTEGER,
  );
  const codePoints = Array.from(cleaned);
  if (codePoints.length <= maxLength) return cleaned;
  return `${codePoints.slice(0, Math.max(0, maxLength - 1)).join("")}…`;
}

function isBlankTitle(title: string): boolean {
  return title.replace(/[\u200c\u200d]/g, "").trim() === "";
}

function lineText(maxLength: number, invisible: RegExp = INVISIBLE_RE) {
  return z.string()
    .transform((s) => sanitizeLine(s, maxLength, invisible))
    .pipe(z.string().min(1));
}

const ulid = z.string().regex(ULID_RE).transform((s) => s.toUpperCase());
const isoDatetime = z.iso.datetime({ offset: true });

const body = z.string()
  .refine((s) => new TextEncoder().encode(s).length <= MAX_INBOX_BODY_BYTES)
  .transform(sanitizeInboxBody);

/**
 * The link's href when it is an `https:` URL carrying no username or
 * password, which could disguise where it leads.
 */
function parseLink(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  try {
    const url = new URL(raw.replace(INVISIBLE_RE, ""));
    return url.protocol === "https:" && url.username === "" &&
        url.password === ""
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * plain-character words only: quotes, ; | & $, backticks, redirects, globs and
 * ~ are refused so the text can never chain or substitute a second command
 */
const SAFE_SWAMP_COMMAND_RE = /^swamp( [A-Za-z0-9@%+,./:=_-]+)+$/;

export type InboxActionCommandSlot =
  | "extension"
  | "collective"
  | "issue"
  | "words";

export interface InboxActionCommandShape {
  readonly words: readonly string[];
  readonly slot?: InboxActionCommandSlot;
}

/**
 * Every command an inbox action may suggest. Anything else drops the action
 * and keeps the message. Swamp Club's send-time check mirrors this list.
 */
export const INBOX_ACTION_COMMANDS: readonly InboxActionCommandShape[] = [
  { words: ["update"] },
  { words: ["quest"] },
  { words: ["inbox"] },
  { words: ["inbox", "read"] },
  { words: ["subscription", "status"] },
  { words: ["subscription", "start"] },
  { words: ["subscription", "start", "--collective"], slot: "collective" },
  { words: ["extension", "pull"], slot: "extension" },
  { words: ["extension", "search"], slot: "words" },
  { words: ["issue", "get"], slot: "issue" },
];

const SLOT_WORD_RE: Record<InboxActionCommandSlot, RegExp> = {
  extension: /^@[a-z0-9_-]+\/[a-z0-9_-]+(\/[a-z0-9_-]+)*$/,
  collective: /^[a-z0-9][a-z0-9-]*$/,
  issue: /^[1-9][0-9]*$/,
  words: /^[A-Za-z0-9_][A-Za-z0-9_-]*$/,
};

function matchesShape(
  words: readonly string[],
  shape: InboxActionCommandShape,
): boolean {
  const fixed = shape.words;
  if (words.length < fixed.length) return false;
  if (!fixed.every((word, i) => words[i] === word)) return false;
  const rest = words.slice(fixed.length);
  if (shape.slot === undefined) return rest.length === 0;
  const pattern = SLOT_WORD_RE[shape.slot];
  const count = shape.slot === "words" ? rest.length : 1;
  return rest.length === count && rest.length > 0 &&
    rest.every((word) => pattern.test(word));
}

/**
 * Whether the command is one {@link INBOX_ACTION_COMMANDS} allows. The text
 * must already pass the shell-syntax rule; a word holding `://` is refused
 * whatever its position, so no command can point swamp at another server.
 */
export function isAllowedInboxActionCommand(command: string): boolean {
  if (!SAFE_SWAMP_COMMAND_RE.test(command)) return false;
  const words = command.split(" ").slice(1);
  if (words.some((word) => word.includes("://"))) return false;
  return INBOX_ACTION_COMMANDS.some((shape) => matchesShape(words, shape));
}

/**
 * The action when it is well formed and suggests an allowed `swamp` command
 * short enough to print whole: a truncated command would not run.
 */
function parseAction(raw: unknown): InboxAction | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const { label, command } = raw as Record<string, unknown>;
  if (typeof label !== "string" || typeof command !== "string") {
    return undefined;
  }
  const cleanLabel = sanitizeLine(label, MAX_INBOX_ACTION_LABEL_LENGTH);
  // refused rather than stripped, since stripping an invisible character could
  // turn a disallowed command into an allowed one; tested on raw text because
  // cleaning trims U+FEFF
  if (HAS_INVISIBLE_RE.test(command)) return undefined;
  const cleanCommand = sanitizeFieldText(command, Number.MAX_SAFE_INTEGER);
  if (
    cleanLabel === "" ||
    cleanCommand.length > MAX_INBOX_ACTION_COMMAND_LENGTH ||
    !isAllowedInboxActionCommand(cleanCommand)
  ) {
    return undefined;
  }
  return { label: cleanLabel, command: cleanCommand };
}

const messageSchema = z.object({
  id: ulid,
  kind: lineText(MAX_INBOX_KIND_LENGTH),
  // Not refused when empty: the message then takes its kind as its title,
  // as Swamp Club does, so a message the summary counts is still shown.
  title: z.string().transform((s) =>
    sanitizeLine(s, MAX_INBOX_TITLE_LENGTH, PROSE_INVISIBLE_RE)
  ),
  body,
  createdAt: isoDatetime,
  link: z.unknown().optional(),
  action: z.unknown().optional(),
  readAt: isoDatetime.nullable(),
}).transform((m): InboxMessage => {
  const link = parseLink(m.link);
  const action = parseAction(m.action);
  // Only the id: the refused text is the server's, and stays out of logs.
  if (m.link != null && link === undefined) {
    logger
      .debug`Inbox message ${m.id}: dropped a link that is not a plain https URL`;
  }
  if (m.action != null && action === undefined) {
    logger
      .debug`Inbox message ${m.id}: dropped an action whose command is not allowed`;
  }
  return {
    id: m.id,
    kind: m.kind,
    title: isBlankTitle(m.title) ? m.kind : m.title,
    body: m.body,
    createdAt: m.createdAt,
    ...(link !== undefined ? { link } : {}),
    ...(action !== undefined ? { action } : {}),
    readAt: m.readAt,
  };
});

const summarySchema = z.object({
  unread: z.number().int().nonnegative(),
  newestId: ulid.nullable(),
  newestAt: isoDatetime.nullable(),
  pollAfterSeconds: z.number().nonnegative(),
});

const pageSchema = z.object({
  messages: z.array(z.unknown()),
  // A message id, so the older-page command swamp suggests holds no server
  // text but a ULID.
  nextCursor: ulid.nullable(),
});

const readSchema = z.object({ read: z.array(z.unknown()) });

const errorSchema = z.object({ error: z.string() });

export function parseInboxSummary(raw: unknown): InboxSummary | undefined {
  const parsed = summarySchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

export function parseInboxMessage(raw: unknown): InboxMessage | undefined {
  const parsed = messageSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

export function parseInboxMessages(raw: readonly unknown[]): InboxMessage[] {
  return raw.flatMap((entry) => {
    const message = parseInboxMessage(entry);
    return message ? [message] : [];
  });
}

export function parseInboxMessagePage(
  raw: unknown,
): InboxMessagePage | undefined {
  const parsed = pageSchema.safeParse(raw);
  if (!parsed.success) return undefined;
  const messages = parseInboxMessages(parsed.data.messages);
  return {
    messages,
    dropped: parsed.data.messages.length - messages.length,
    nextCursor: parsed.data.nextCursor,
  };
}

export function parseInboxReadIds(raw: unknown): string[] | undefined {
  const parsed = readSchema.safeParse(raw);
  if (!parsed.success) return undefined;
  return parsed.data.read.filter((id): id is string => typeof id === "string");
}

export function parseInboxErrorCode(raw: unknown): string | undefined {
  const parsed = errorSchema.safeParse(raw);
  return parsed.success ? parsed.data.error : undefined;
}
