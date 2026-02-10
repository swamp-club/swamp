/**
 * Token type for YAML syntax highlighting.
 */
export type TokenType =
  | "key"
  | "string"
  | "number"
  | "boolean"
  | "null"
  | "comment"
  | "text";

/**
 * A highlighted token with its type and text.
 */
export interface HighlightToken {
  type: TokenType;
  text: string;
}

/**
 * A line of highlighted tokens.
 */
export interface HighlightedLine {
  tokens: HighlightToken[];
}

/**
 * Highlights YAML content with simple token-based highlighting.
 *
 * Colors:
 * - cyan for keys
 * - green for strings
 * - yellow for numbers
 * - magenta for booleans
 * - gray for comments
 * - gray for null
 *
 * @param yaml - The YAML content to highlight
 * @returns Array of highlighted lines
 */
export function highlightYaml(yaml: string): HighlightedLine[] {
  const lines = yaml.split("\n");
  return lines.map(highlightLine);
}

/**
 * Highlights a single line of YAML.
 */
function highlightLine(line: string): HighlightedLine {
  const tokens: HighlightToken[] = [];

  // Empty line
  if (line.trim() === "") {
    tokens.push({ type: "text", text: line });
    return { tokens };
  }

  // Comment line
  const commentMatch = line.match(/^(\s*)(#.*)$/);
  if (commentMatch) {
    const [, indent, comment] = commentMatch;
    if (indent) {
      tokens.push({ type: "text", text: indent });
    }
    tokens.push({ type: "comment", text: comment });
    return { tokens };
  }

  // Key-value line
  const kvMatch = line.match(/^(\s*)([^:\s][^:]*?)(:)(\s*)(.*)$/);
  if (kvMatch) {
    const [, indent, key, colon, space, value] = kvMatch;

    if (indent) {
      tokens.push({ type: "text", text: indent });
    }
    tokens.push({ type: "key", text: key });
    tokens.push({ type: "text", text: colon });
    if (space) {
      tokens.push({ type: "text", text: space });
    }

    if (value) {
      tokens.push(...highlightValue(value));
    }

    return { tokens };
  }

  // List item line
  const listMatch = line.match(/^(\s*)(-)(\s*)(.*)$/);
  if (listMatch) {
    const [, indent, dash, space, value] = listMatch;

    if (indent) {
      tokens.push({ type: "text", text: indent });
    }
    tokens.push({ type: "text", text: dash });
    if (space) {
      tokens.push({ type: "text", text: space });
    }

    if (value) {
      // Check if it's a key-value pair after the dash
      const itemKvMatch = value.match(/^([^:\s][^:]*?)(:)(\s*)(.*)$/);
      if (itemKvMatch) {
        const [, itemKey, itemColon, itemSpace, itemValue] = itemKvMatch;
        tokens.push({ type: "key", text: itemKey });
        tokens.push({ type: "text", text: itemColon });
        if (itemSpace) {
          tokens.push({ type: "text", text: itemSpace });
        }
        if (itemValue) {
          tokens.push(...highlightValue(itemValue));
        }
      } else {
        tokens.push(...highlightValue(value));
      }
    }

    return { tokens };
  }

  // Default: just text
  tokens.push({ type: "text", text: line });
  return { tokens };
}

/**
 * Highlights a value portion of a YAML line.
 */
function highlightValue(value: string): HighlightToken[] {
  const trimmed = value.trim();

  // Check for inline comment
  const commentIdx = value.indexOf(" #");
  if (commentIdx !== -1) {
    const mainValue = value.substring(0, commentIdx);
    const comment = value.substring(commentIdx);
    return [
      ...highlightValue(mainValue),
      { type: "comment", text: comment },
    ];
  }

  // Quoted string (single or double)
  if (/^(['"]).*\1$/.test(trimmed)) {
    return [{ type: "string", text: value }];
  }

  // Boolean
  if (/^(true|false|yes|no|on|off)$/i.test(trimmed)) {
    return [{ type: "boolean", text: value }];
  }

  // Null
  if (/^(null|~)$/i.test(trimmed)) {
    return [{ type: "null", text: value }];
  }

  // Number (integer or float)
  if (/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(trimmed)) {
    return [{ type: "number", text: value }];
  }

  // Unquoted string (treat as string for display)
  if (trimmed.length > 0) {
    return [{ type: "string", text: value }];
  }

  return [{ type: "text", text: value }];
}

/**
 * Gets the color for a token type.
 */
export function getTokenColor(type: TokenType): string {
  const colors: Record<TokenType, string> = {
    key: "cyan",
    string: "green",
    number: "yellow",
    boolean: "magenta",
    null: "gray",
    comment: "gray",
    text: "white",
  };
  return colors[type];
}
