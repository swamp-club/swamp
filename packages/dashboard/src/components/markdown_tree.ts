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

import { Lexer, type Token, type Tokens } from "marked";

/**
 * Report markdown is written by extensions, so it is untrusted. It is parsed
 * with marked's lexer only and mapped to this plain tree, which the Markdown
 * component renders as React elements. No HTML string is ever produced, so
 * raw HTML in a report is shown as text and cannot run.
 */
export type MdInline =
  | { type: "text"; text: string }
  | { type: "strong" | "em" | "del"; children: MdInline[] }
  | { type: "codespan"; text: string }
  | { type: "link"; href: string; external: boolean; children: MdInline[] }
  | { type: "br" };

export type MdAlign = "left" | "center" | "right" | null;

export interface MdListItem {
  checked?: boolean;
  children: MdBlock[];
}

export type MdBlock =
  | { type: "heading"; depth: number; children: MdInline[] }
  | { type: "paragraph"; children: MdInline[] }
  | { type: "code"; lang: string; text: string }
  | { type: "list"; ordered: boolean; start?: number; items: MdListItem[] }
  | {
    type: "table";
    align: MdAlign[];
    header: MdInline[][];
    rows: MdInline[][][];
  }
  | { type: "blockquote"; children: MdBlock[] }
  | { type: "hr" }
  | { type: "text"; text: string };

const SAFE_PROTOCOLS: ReadonlySet<string> = new Set([
  "http:",
  "https:",
  "mailto:",
]);

/**
 * Resolves a link against the page and allows it only if it parses to
 * http(s) or mailto — which also rejects protocol-relative tricks and
 * whitespace- or case-obfuscated schemes such as `JaVa\tscript:`.
 */
export function safeHref(
  href: string,
  base: string,
): { href: string; external: boolean } | null {
  let url: URL;
  try {
    url = new URL(href, base);
  } catch {
    return null;
  }
  if (!SAFE_PROTOCOLS.has(url.protocol)) return null;
  return { href: url.href, external: url.origin !== new URL(base).origin };
}

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
};

/**
 * marked 14 HTML-escapes inline text, code spans and escapes. The output is
 * React text, which escapes on its own, so undo marked's escaping here to
 * avoid showing `&lt;` literally. Fenced code and html token text is raw
 * and must not go through this.
 */
export function decodeEntities(text: string): string {
  return text.replace(/&(?:amp|lt|gt|quot|#39);/g, (m) => ENTITIES[m]);
}

function inlines(tokens: Token[] | undefined, base: string): MdInline[] {
  const out: MdInline[] = [];
  for (const token of tokens ?? []) {
    for (const node of inline(token, base)) out.push(node);
  }
  return out;
}

function inline(token: Token, base: string): MdInline[] {
  switch (token.type) {
    case "text": {
      const t = token as Tokens.Text;
      return t.tokens
        ? inlines(t.tokens, base)
        : [{ type: "text", text: decodeEntities(t.text) }];
    }
    case "escape":
      return [{
        type: "text",
        text: decodeEntities((token as Tokens.Escape).text),
      }];
    case "codespan":
      return [{
        type: "codespan",
        text: decodeEntities((token as Tokens.Codespan).text),
      }];
    case "strong":
    case "em":
    case "del":
      return [{
        type: token.type,
        children: inlines((token as Tokens.Strong).tokens, base),
      }];
    case "br":
      return [{ type: "br" }];
    case "link": {
      const t = token as Tokens.Link;
      const children = inlines(t.tokens, base);
      const safe = safeHref(t.href, base);
      return safe ? [{ type: "link", ...safe, children }] : children;
    }
    case "image": {
      // Never load images from a report: an external image would tell its
      // host who viewed the report. Show the alt text, linked if safe.
      const t = token as Tokens.Image;
      const text: MdInline = { type: "text", text: t.text || t.href };
      const safe = safeHref(t.href, base);
      return safe ? [{ type: "link", ...safe, children: [text] }] : [text];
    }
    case "html":
      return [{ type: "text", text: (token as Tokens.HTML).text }];
    default:
      return "raw" in token && typeof token.raw === "string"
        ? [{ type: "text", text: token.raw }]
        : [];
  }
}

function blocks(tokens: Token[], base: string): MdBlock[] {
  const out: MdBlock[] = [];
  for (const token of tokens) {
    const node = block(token, base);
    if (node) out.push(node);
  }
  return out;
}

function block(token: Token, base: string): MdBlock | null {
  switch (token.type) {
    case "space":
    case "def":
      return null;
    case "heading": {
      const t = token as Tokens.Heading;
      return {
        type: "heading",
        depth: t.depth,
        children: inlines(t.tokens, base),
      };
    }
    case "paragraph":
      return {
        type: "paragraph",
        children: inlines((token as Tokens.Paragraph).tokens, base),
      };
    case "text": {
      // Block-level text, e.g. a tight list item's content.
      const t = token as Tokens.Text;
      return {
        type: "paragraph",
        children: t.tokens
          ? inlines(t.tokens, base)
          : [{ type: "text", text: decodeEntities(t.text) }],
      };
    }
    case "code": {
      const t = token as Tokens.Code;
      return { type: "code", lang: t.lang ?? "", text: t.text };
    }
    case "list": {
      const t = token as Tokens.List;
      const start = typeof t.start === "number" ? t.start : undefined;
      return {
        type: "list",
        ordered: t.ordered,
        ...(t.ordered && start !== undefined && start !== 1 && { start }),
        items: t.items.map((item) => ({
          ...(item.task && { checked: item.checked ?? false }),
          children: blocks(item.tokens, base),
        })),
      };
    }
    case "table": {
      const t = token as Tokens.Table;
      return {
        type: "table",
        align: t.align,
        header: t.header.map((cell) => inlines(cell.tokens, base)),
        rows: t.rows.map((row) =>
          row.map((cell) => inlines(cell.tokens, base))
        ),
      };
    }
    case "blockquote":
      return {
        type: "blockquote",
        children: blocks((token as Tokens.Blockquote).tokens, base),
      };
    case "hr":
      return { type: "hr" };
    case "html":
      return {
        type: "text",
        text: (token as Tokens.HTML).text.replace(/\n+$/, ""),
      };
    default:
      return "raw" in token && typeof token.raw === "string"
        ? { type: "text", text: token.raw }
        : null;
  }
}

/** Parses markdown into the renderable tree. `base` resolves relative links. */
export function parseMarkdown(markdown: string, base: string): MdBlock[] {
  return blocks(Lexer.lex(markdown, { gfm: true }), base);
}
