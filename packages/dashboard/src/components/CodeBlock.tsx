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

interface CodeBlockProps {
  code: string;
  language?: "json" | "yaml";
}

export function CodeBlock({ code, language = "json" }: CodeBlockProps) {
  const highlighted = language === "json"
    ? highlightJson(code)
    : highlightYaml(code);

  return (
    <pre
      className="code-block"
      dangerouslySetInnerHTML={{ __html: highlighted }}
    />
  );
}

function highlightJson(raw: string): string {
  // escapeHtml neutralizes <, >, & for XSS safety. Quotes stay as
  // literal " so the regexes below match them directly.
  const safe = escapeHtml(raw);
  return safe.replace(
    /("(?:[^"\\]|\\.)*")\s*:/g,
    '<span class="code-key">$1</span>:',
  ).replace(
    /:\s*("(?:[^"\\]|\\.)*")/g,
    ': <span class="code-string">$1</span>',
  ).replace(
    /:\s*(\d+(?:\.\d+)?)\b/g,
    ': <span class="code-number">$1</span>',
  ).replace(
    /:\s*(true|false)\b/g,
    ': <span class="code-boolean">$1</span>',
  ).replace(
    /:\s*(null)\b/g,
    ': <span class="code-null">$1</span>',
  );
}

function highlightYaml(raw: string): string {
  return raw.split("\n").map((line) => {
    const safeLine = escapeHtml(line);
    if (line.trimStart().startsWith("#")) {
      return `<span class="code-comment">${safeLine}</span>`;
    }
    return safeLine
      .replace(
        /^(\s*)([\w.-]+)(:)/,
        '$1<span class="code-key">$2</span>$3',
      )
      .replace(
        /:\s+"([^"]*)"$/,
        ': <span class="code-string">"$1"</span>',
      )
      .replace(
        /:\s+'([^']*)'$/,
        ": <span class=\"code-string\">'$1'</span>",
      )
      .replace(
        /:\s+(\d+(?:\.\d+)?)$/,
        ': <span class="code-number">$1</span>',
      )
      .replace(
        /:\s+(true|false)$/,
        ': <span class="code-boolean">$1</span>',
      )
      .replace(
        /:\s+(null)$/,
        ': <span class="code-null">$1</span>',
      );
  }).join("\n");
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
