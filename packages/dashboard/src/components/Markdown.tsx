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

import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

interface MarkdownProps {
  source: string;
}

// Report Markdown is produced by extension code, and this page holds an
// authenticated session that can run methods. So raw HTML is dropped
// (skipHtml, no rehype-raw), link URLs keep react-markdown's default
// urlTransform (which removes javascript: and other unsafe protocols), and
// images render as links instead of loading, so opening a report never
// makes the browser fetch an arbitrary URL.
const COMPONENTS: Components = {
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>
  ),
  img: ({ src, alt }) =>
    typeof src === "string" && src
      ? (
        <a href={src} target="_blank" rel="noopener noreferrer">
          {alt || src}
        </a>
      )
      : <span>{alt}</span>,
};

export function Markdown({ source }: MarkdownProps) {
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        components={COMPONENTS}
      >
        {source}
      </ReactMarkdown>
    </div>
  );
}
