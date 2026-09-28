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

import { Fragment, type ReactNode, useMemo } from "react";
import { CodeBlock } from "./CodeBlock";
import { type MdBlock, type MdInline, parseMarkdown } from "./markdown_tree.ts";

/**
 * Renders untrusted markdown (e.g. report output) as React elements. See
 * markdown_tree.ts: no HTML string is ever built, so nothing in the source runs.
 */
export function Markdown({ source }: { source: string }) {
  const tree = useMemo(() => parseMarkdown(source, location.href), [source]);
  return <div className="markdown">{renderBlocks(tree)}</div>;
}

function renderBlocks(nodes: MdBlock[]): ReactNode {
  return nodes.map((node, i) => <Fragment key={i}>{renderBlock(node)}
  </Fragment>);
}

function renderInlines(nodes: MdInline[]): ReactNode {
  return nodes.map((node, i) => (
    <Fragment key={i}>{renderInline(node)}</Fragment>
  ));
}

function renderBlock(node: MdBlock): ReactNode {
  switch (node.type) {
    case "heading": {
      const Tag = `h${Math.min(Math.max(node.depth, 1), 6)}` as
        | "h1"
        | "h2"
        | "h3"
        | "h4"
        | "h5"
        | "h6";
      return <Tag>{renderInlines(node.children)}</Tag>;
    }
    case "paragraph":
      return <p>{renderInlines(node.children)}</p>;
    case "code":
      return node.lang === "json" || node.lang === "yaml"
        ? <CodeBlock code={node.text} language={node.lang} />
        : <pre className="code-block">{node.text}</pre>;
    case "list": {
      const items = node.items.map((item, i) => (
        <li
          key={i}
          className={item.checked !== undefined ? "task" : undefined}
        >
          {item.checked !== undefined && (
            <input type="checkbox" checked={item.checked} disabled readOnly />
          )}
          {renderBlocks(item.children)}
        </li>
      ));
      return node.ordered
        ? <ol start={node.start}>{items}</ol>
        : <ul>{items}</ul>;
    }
    case "table":
      return (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                {node.header.map((cell, i) => (
                  <th key={i} style={{ textAlign: node.align[i] ?? undefined }}>
                    {renderInlines(cell)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {node.rows.map((row, r) => (
                <tr key={r}>
                  {row.map((cell, i) => (
                    <td
                      key={i}
                      style={{ textAlign: node.align[i] ?? undefined }}
                    >
                      {renderInlines(cell)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case "blockquote":
      return <blockquote>{renderBlocks(node.children)}</blockquote>;
    case "hr":
      return <hr />;
    case "text":
      return <p className="markdown-raw">{node.text}</p>;
  }
}

function renderInline(node: MdInline): ReactNode {
  switch (node.type) {
    case "text":
      return node.text;
    case "strong":
      return <strong>{renderInlines(node.children)}</strong>;
    case "em":
      return <em>{renderInlines(node.children)}</em>;
    case "del":
      return <del>{renderInlines(node.children)}</del>;
    case "codespan":
      return <code>{node.text}</code>;
    case "br":
      return <br />;
    case "link":
      return node.external
        ? (
          <a href={node.href} target="_blank" rel="noopener noreferrer">
            {renderInlines(node.children)}
          </a>
        )
        : <a href={node.href}>{renderInlines(node.children)}</a>;
  }
}
