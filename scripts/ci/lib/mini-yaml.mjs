/**
 * A deliberately small, strict YAML reader for the QA-101 workflow contract test.
 *
 * The repository keeps its tooling dependency-free, so instead of adding a YAML package
 * just to assert on one workflow file, this module parses the exact subset GitHub
 * Actions workflows use here:
 *
 * - block mappings and block sequences
 * - plain, single-quoted, and double-quoted scalars
 * - literal (`|`) and folded (`>`) block scalars with `-`/`+` chomping
 * - flow sequences (`[a, b]`) and flow mappings (`{}`, `{a: b}`)
 * - `#` comments and blank lines
 *
 * Anything outside that subset throws with a line number. That is intentional: a
 * parse failure must be a loud test failure, never a silently empty document that makes
 * the contract assertions pass vacuously.
 *
 * Mapping keys are always returned as strings, so the YAML 1.1 "Norway problem"
 * (`on:` becoming the boolean `true`) cannot corrupt a workflow assertion.
 */

class YamlError extends Error {
  /**
   * @param {string} message
   * @param {number} line
   */
  constructor(message, line) {
    super(`${message} (line ${line})`);
    this.name = "YamlError";
    this.line = line;
  }
}

/**
 * @param {string} raw
 * @returns {number}
 */
function indentOf(raw) {
  let count = 0;
  while (count < raw.length && raw[count] === " ") count += 1;
  return count;
}

/**
 * @param {string} raw
 * @returns {boolean}
 */
function isIgnorable(raw) {
  const trimmed = raw.trim();
  return trimmed === "" || trimmed.startsWith("#");
}

/**
 * Removes a trailing ` # comment` that is not inside quotes.
 *
 * @param {string} text
 * @returns {string}
 */
function stripComment(text) {
  let quote = null;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quote) {
      if (character === "\\" && quote === '"') {
        index += 1;
      } else if (character === quote) {
        quote = null;
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === "#" && (index === 0 || text[index - 1] === " ")) {
      return text.slice(0, index);
    }
  }
  return text;
}

/**
 * @param {string} text
 * @param {number} line
 * @returns {unknown}
 */
function parseScalar(text, line) {
  const value = text.trim();
  if (value === "") return null;
  if (value === "~" || value === "null") return null;
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^-?\d+$/.test(value)) return Number(value);
  if (/^-?\d+\.\d+$/.test(value)) return Number(value);

  if (value.startsWith('"')) {
    if (!value.endsWith('"') || value.length < 2) {
      throw new YamlError("Unterminated double-quoted scalar", line);
    }
    return JSON.parse(value);
  }
  if (value.startsWith("'")) {
    if (!value.endsWith("'") || value.length < 2) {
      throw new YamlError("Unterminated single-quoted scalar", line);
    }
    return value.slice(1, -1).replaceAll("''", "'");
  }
  if (value.startsWith("[") || value.startsWith("{")) {
    return parseFlow(value, line);
  }
  if (value.startsWith("&") || value.startsWith("*") || value.startsWith("!")) {
    throw new YamlError(`Unsupported YAML construct: ${value}`, line);
  }
  return value;
}

/**
 * Splits a flow collection body on top-level commas.
 *
 * @param {string} body
 * @param {number} line
 * @returns {string[]}
 */
function splitFlowItems(body, line) {
  /** @type {string[]} */
  const items = [];
  let depth = 0;
  let quote = null;
  let start = 0;

  for (let index = 0; index < body.length; index += 1) {
    const character = body[index];
    if (quote) {
      if (character === "\\" && quote === '"') index += 1;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
    } else if (character === "[" || character === "{") {
      depth += 1;
    } else if (character === "]" || character === "}") {
      depth -= 1;
      if (depth < 0) throw new YamlError("Unbalanced flow collection", line);
    } else if (character === "," && depth === 0) {
      items.push(body.slice(start, index));
      start = index + 1;
    }
  }
  if (quote) throw new YamlError("Unterminated quoted scalar in flow collection", line);
  if (depth !== 0) throw new YamlError("Unbalanced flow collection", line);

  const tail = body.slice(start);
  if (tail.trim() !== "" || items.length > 0) items.push(tail);
  return items;
}

/**
 * @param {string} text
 * @param {number} line
 * @returns {unknown}
 */
function parseFlow(text, line) {
  const value = text.trim();
  if (value.startsWith("[")) {
    if (!value.endsWith("]")) throw new YamlError("Unterminated flow sequence", line);
    return splitFlowItems(value.slice(1, -1), line)
      .filter((item) => item.trim() !== "")
      .map((item) => parseScalar(item, line));
  }
  if (!value.endsWith("}")) throw new YamlError("Unterminated flow mapping", line);

  /** @type {Record<string, unknown>} */
  const mapping = {};
  for (const item of splitFlowItems(value.slice(1, -1), line)) {
    if (item.trim() === "") continue;
    const separator = item.indexOf(":");
    if (separator === -1) throw new YamlError("Flow mapping entry without a key", line);
    mapping[item.slice(0, separator).trim()] = parseScalar(item.slice(separator + 1), line);
  }
  return mapping;
}

/**
 * Finds the `:` that separates a block-mapping key from its value, ignoring colons
 * inside quotes and requiring the colon to end the line or be followed by a space.
 *
 * @param {string} content
 * @returns {number}
 */
function findKeySeparator(content) {
  let quote = null;
  for (let index = 0; index < content.length; index += 1) {
    const character = content[index];
    if (quote) {
      if (character === "\\" && quote === '"') index += 1;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === ":" && (index === content.length - 1 || content[index + 1] === " ")) {
      return index;
    }
  }
  return -1;
}

/** @typedef {{ raw: string, number: number }} SourceLine */

class Reader {
  /** @param {SourceLine[]} lines */
  constructor(lines) {
    this.lines = lines;
    this.index = 0;
  }

  skipIgnorable() {
    while (this.index < this.lines.length && isIgnorable(this.lines[this.index].raw)) {
      this.index += 1;
    }
  }

  /** @returns {SourceLine | null} */
  peek() {
    this.skipIgnorable();
    return this.index < this.lines.length ? this.lines[this.index] : null;
  }
}

/**
 * Consumes a `|`/`>` block scalar body.
 *
 * @param {Reader} reader
 * @param {string} header
 * @param {number} parentIndent
 * @param {number} line
 * @returns {string}
 */
function readBlockScalar(reader, header, parentIndent, line) {
  const match = /^([|>])([-+]?)$/.exec(header.trim());
  if (!match) throw new YamlError(`Unsupported block scalar header: ${header}`, line);
  const [, style, chomping] = match;

  /** @type {string[]} */
  const body = [];
  let blockIndent = null;

  while (reader.index < reader.lines.length) {
    const candidate = reader.lines[reader.index];
    if (candidate.raw.trim() === "") {
      body.push("");
      reader.index += 1;
      continue;
    }
    const indent = indentOf(candidate.raw);
    if (indent <= parentIndent) break;
    if (blockIndent === null) blockIndent = indent;
    if (indent < blockIndent) break;
    body.push(candidate.raw.slice(blockIndent));
    reader.index += 1;
  }

  while (body.length > 0 && body[body.length - 1] === "") body.pop();

  let text;
  if (style === "|") {
    text = body.join("\n");
  } else {
    /** @type {string[]} */
    const folded = [];
    for (const entry of body) {
      if (entry === "") {
        folded.push("\n");
      } else if (folded.length > 0 && folded[folded.length - 1] !== "\n") {
        folded[folded.length - 1] = `${folded[folded.length - 1]} ${entry}`;
      } else {
        folded.push(entry);
      }
    }
    text = folded.join("");
  }

  if (chomping === "-") return text;
  return text === "" ? "" : `${text}\n`;
}

/**
 * @param {Reader} reader
 * @param {number} indent
 * @returns {unknown}
 */
function parseBlock(reader, indent) {
  const first = reader.peek();
  if (first === null) return null;
  const content = first.raw.slice(indent);
  if (content.startsWith("- ") || content.trimEnd() === "-") {
    return parseSequence(reader, indent);
  }
  return parseMapping(reader, indent);
}

/**
 * @param {Reader} reader
 * @param {number} indent
 * @returns {unknown[]}
 */
function parseSequence(reader, indent) {
  /** @type {unknown[]} */
  const items = [];

  for (;;) {
    const line = reader.peek();
    if (line === null) break;
    const lineIndent = indentOf(line.raw);
    if (lineIndent < indent) break;
    if (lineIndent > indent) throw new YamlError("Unexpected indentation in sequence", line.number);

    const content = line.raw.slice(indent);
    if (!content.startsWith("-")) break;
    if (content.length > 1 && content[1] !== " ") {
      throw new YamlError("Sequence dash must be followed by a space", line.number);
    }

    const rest = content.slice(1);
    const restOffset = rest.length - rest.trimStart().length;
    if (rest.trim() === "") {
      reader.index += 1;
      const nested = reader.peek();
      if (nested === null || indentOf(nested.raw) <= indent) {
        items.push(null);
        continue;
      }
      items.push(parseBlock(reader, indentOf(nested.raw)));
      continue;
    }

    const body = stripComment(rest).trim();
    if (findKeySeparator(body) === -1) {
      // A plain scalar item such as `- main`.
      items.push(parseScalar(body, line.number));
      reader.index += 1;
      continue;
    }

    // Rewrite `- key: value` as `  key: value` in place so the entry can be parsed as an
    // ordinary block starting at the column where its content begins.
    const itemIndent = indent + 1 + restOffset;
    reader.lines[reader.index] = {
      raw: " ".repeat(itemIndent) + line.raw.slice(itemIndent),
      number: line.number,
    };
    items.push(parseBlock(reader, itemIndent));
  }

  return items;
}

/**
 * @param {Reader} reader
 * @param {number} indent
 * @returns {Record<string, unknown>}
 */
function parseMapping(reader, indent) {
  /** @type {Record<string, unknown>} */
  const mapping = {};

  for (;;) {
    const line = reader.peek();
    if (line === null) break;
    const lineIndent = indentOf(line.raw);
    if (lineIndent < indent) break;
    if (lineIndent > indent) throw new YamlError("Unexpected indentation in mapping", line.number);

    const content = line.raw.slice(indent);
    if (content.startsWith("- ")) break;
    if (content.startsWith("---") || content.startsWith("...")) {
      throw new YamlError("Multi-document YAML is not supported", line.number);
    }

    const separator = findKeySeparator(content);
    if (separator === -1) throw new YamlError(`Expected a "key: value" entry`, line.number);

    const rawKey = content.slice(0, separator).trim();
    const key =
      rawKey.startsWith('"') || rawKey.startsWith("'")
        ? String(parseScalar(rawKey, line.number))
        : rawKey;
    if (key === "") throw new YamlError("Empty mapping key", line.number);
    if (Object.hasOwn(mapping, key)) {
      throw new YamlError(`Duplicate mapping key: ${key}`, line.number);
    }

    const rawValue = stripComment(content.slice(separator + 1)).trim();
    reader.index += 1;

    if (/^[|>][-+]?$/.test(rawValue)) {
      mapping[key] = readBlockScalar(reader, rawValue, indent, line.number);
      continue;
    }

    if (rawValue !== "") {
      mapping[key] = parseScalar(rawValue, line.number);
      continue;
    }

    const nested = reader.peek();
    if (nested === null) {
      mapping[key] = null;
      continue;
    }
    const nestedIndent = indentOf(nested.raw);
    if (nestedIndent > indent) {
      mapping[key] = parseBlock(reader, nestedIndent);
      continue;
    }
    // A sequence may be written at the same indentation as its key.
    if (nestedIndent === indent && nested.raw.slice(indent).startsWith("-")) {
      mapping[key] = parseSequence(reader, indent);
      continue;
    }
    mapping[key] = null;
  }

  return mapping;
}

/**
 * Parses a YAML document from the supported subset.
 *
 * @param {string} text
 * @returns {unknown}
 */
export function parseYaml(text) {
  if (text.includes("\t")) {
    const line = text.slice(0, text.indexOf("\t")).split("\n").length;
    throw new YamlError("Tabs are not valid YAML indentation", line);
  }

  const lines = text.split(/\r?\n/).map((raw, position) => ({ raw, number: position + 1 }));
  const reader = new Reader(lines);
  const first = reader.peek();
  if (first === null) return null;

  const value = parseBlock(reader, indentOf(first.raw));
  const trailing = reader.peek();
  if (trailing !== null) {
    throw new YamlError("Unparsed trailing content", trailing.number);
  }
  return value;
}

export { YamlError };
