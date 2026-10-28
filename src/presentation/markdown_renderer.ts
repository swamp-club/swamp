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

import { Marked } from "marked";
import TerminalRenderer from "marked-terminal";

const terminalMarked = new Marked();
terminalMarked.setOptions({
  // deno-lint-ignore no-explicit-any
  renderer: new (TerminalRenderer as any)(),
});

export interface WidthOptions {
  maxWidth?: number;
  maxColWidth?: number;
}

export function renderMarkdownToTerminal(
  markdown: string,
  options?: WidthOptions,
): string {
  let md = markdown;
  if (options?.maxColWidth) {
    md = truncateMarkdownTableCells(md, options.maxColWidth);
  }

  if (options?.maxWidth) {
    const widthMarked = new Marked();
    widthMarked.setOptions({
      // deno-lint-ignore no-explicit-any
      renderer: new (TerminalRenderer as any)({
        width: options.maxWidth,
        reflowText: true,
        tableOptions: { wordWrap: true },
      }),
    });
    const result = widthMarked.parse(md);
    if (typeof result === "string") {
      return result;
    }
    return md;
  }

  const result = terminalMarked.parse(md);
  if (typeof result === "string") {
    return result;
  }
  return md;
}

interface LinkToken {
  href: string;
  text: string;
  tokens: unknown[];
}

interface ImageToken {
  href: string;
  text: string;
}

/** What an untrusted link prints in place of a target it refuses. */
export const LINK_REMOVED = "(link removed)";

/**
 * The target an untrusted link may print: the parsed URL, so a look-alike
 * host shows as punycode and the path is encoded. Undefined for anything but
 * an `https:` URL without a username or password, which could disguise where
 * it leads.
 */
function safeHref(href: string): string | undefined {
  try {
    const url = new URL(href);
    return url.protocol === "https:" && url.username === "" &&
        url.password === ""
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A terminal renderer whose links always print their target. marked-terminal
 * turns a link into an OSC 8 hyperlink where the terminal supports one, which
 * shows only the link text and so can disguise where it leads. Autolinks and
 * reference links reach the same hook; images print their target the same
 * way.
 */
function visibleLinkRenderer(rendererOptions: Record<string, unknown>) {
  // deno-lint-ignore no-explicit-any
  const renderer = new (TerminalRenderer as any)(rendererOptions);
  renderer.link = function (
    this: {
      parser: { parseInline(tokens: unknown[]): string };
      o: { link(s: string): string; href(s: string): string };
    },
    token: LinkToken,
  ): string {
    const text = this.parser.parseInline(token.tokens);
    const target = safeHref(token.href);
    // A bare `www.` or email autolink: its text is its whole target, so
    // printing the text hides nothing, and prose that names a site or an
    // address reads as written.
    if (
      target === undefined &&
      (token.href === `http://${token.text}` ||
        token.href === `mailto:${token.text}`)
    ) {
      return text;
    }
    if (target === undefined) {
      return text ? `${text} ${LINK_REMOVED}` : LINK_REMOVED;
    }
    const href = this.o.href(target);
    return this.o.link(
      text && text !== token.href && text !== target
        ? `${text} (${href})`
        : href,
    );
  };
  renderer.image = function (
    this: { o: { href(s: string): string } },
    token: ImageToken,
  ): string {
    const target = safeHref(token.href);
    const text = token.text ? `![${token.text}]` : "![]";
    return target === undefined
      ? `${text} ${LINK_REMOVED}`
      : `${text}(${this.o.href(target)})`;
  };
  return renderer;
}

/**
 * Renders markdown that someone else wrote, such as a Swamp Club inbox
 * message, for the terminal. Same as renderMarkdownToTerminal, except that
 * every link shows its target as text, whatever the terminal supports.
 */
export function renderUntrustedMarkdownToTerminal(
  markdown: string,
  options?: WidthOptions,
): string {
  const marked = new Marked();
  marked.setOptions({
    renderer: visibleLinkRenderer(
      options?.maxWidth
        ? {
          width: options.maxWidth,
          reflowText: true,
          tableOptions: { wordWrap: true },
        }
        : {},
    ),
  });
  const md = options?.maxColWidth
    ? truncateMarkdownTableCells(markdown, options.maxColWidth)
    : markdown;
  const result = marked.parse(md);
  return typeof result === "string" ? result : md;
}

export function renderMarkdownPlain(
  markdown: string,
  options?: WidthOptions,
): string {
  if (options?.maxColWidth) {
    return truncateMarkdownTableCells(markdown, options.maxColWidth);
  }
  return markdown;
}

const TABLE_SEPARATOR_RE = /^\|[\s:]*-+[\s:]*(\|[\s:]*-+[\s:]*)*\|?\s*$/;

export function truncateMarkdownTableCells(
  markdown: string,
  maxColWidth: number,
): string {
  const lines = markdown.split("\n");
  const result: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (
      !trimmed.startsWith("|") ||
      TABLE_SEPARATOR_RE.test(trimmed)
    ) {
      result.push(line);
      continue;
    }

    const cells = splitTableRow(trimmed);
    const truncated = cells.map((cell) => {
      const stripped = cell.trim();
      if (stripped.length <= maxColWidth) return cell;
      return " " + stripped.slice(0, maxColWidth - 1) + "…" + " ";
    });
    result.push("|" + truncated.join("|") + "|");
  }

  return result.join("\n");
}

function splitTableRow(row: string): string[] {
  let inner = row;
  if (inner.startsWith("|")) inner = inner.slice(1);
  if (inner.endsWith("|")) inner = inner.slice(0, -1);

  const cells: string[] = [];
  let current = "";
  let inCode = false;

  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch === "`") {
      inCode = !inCode;
      current += ch;
    } else if (ch === "\\" && i + 1 < inner.length) {
      current += ch + inner[i + 1];
      i++;
    } else if (ch === "|" && !inCode) {
      cells.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  cells.push(current);
  return cells;
}
