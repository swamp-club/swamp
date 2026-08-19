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
  return raw.replace(
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
    if (line.trimStart().startsWith("#")) {
      return `<span class="code-comment">${escapeHtml(line)}</span>`;
    }
    return line
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
