// @ts-check
'use strict';

/**
 * Zero-dependency SKILL.md frontmatter parser.
 *
 * It supports the YAML subset that skill frontmatter uses in practice:
 * block mappings and sequences, plain, single-quoted and double-quoted
 * scalars, literal (|) and folded (>) block scalars with chomping
 * indicators, flow sequences/mappings ([a, b] / {k: v}), and comments.
 * Anchors, aliases and tags are not resolved; they produce a warning.
 *
 * Problems carry 1-based line numbers that refer to the whole SKILL.md file.
 */

/** @typedef {{ line: number, message: string, code: string }} YamlIssue */

/**
 * @typedef {object} FrontmatterResult
 * @property {boolean} hasFrontmatter  true when the file starts with a `---` line
 * @property {boolean} closed          true when a closing `---` (or `...`) line was found
 * @property {any} data                parsed value (usually a plain object) or null
 * @property {Record<string, number>} keyLines  top-level key -> 1-based line
 * @property {string} body             text after the closing delimiter
 * @property {number} bodyStartLine    1-based line number of the first body line
 * @property {YamlIssue[]} errors
 * @property {YamlIssue[]} warnings
 */

const MAX_FRONTMATTER_LINES = 2000;

/**
 * @param {string} text full SKILL.md content
 * @returns {FrontmatterResult}
 */
function parseFrontmatter(text) {
  /** @type {FrontmatterResult} */
  const result = {
    hasFrontmatter: false,
    closed: false,
    data: null,
    keyLines: {},
    body: '',
    bodyStartLine: 1,
    errors: [],
    warnings: [],
  };
  if (typeof text !== 'string') {
    result.errors.push({ line: 1, code: 'yaml', message: 'SKILL.md content is not text.' });
    return result;
  }
  let src = text;
  if (src.charCodeAt(0) === 0xfeff) src = src.slice(1);
  const lines = src.replace(/\r\n?/g, '\n').split('\n');

  if (!/^---[ \t]*$/.test(lines[0] || '')) {
    result.body = lines.join('\n');
    result.bodyStartLine = 1;
    return result;
  }
  result.hasFrontmatter = true;

  let end = -1;
  for (let i = 1; i < lines.length && i <= MAX_FRONTMATTER_LINES; i++) {
    if (/^(---|\.\.\.)[ \t]*$/.test(lines[i])) {
      end = i;
      break;
    }
  }
  if (end === -1) {
    result.errors.push({
      line: 1,
      code: 'frontmatter-unclosed',
      message: 'Frontmatter starts with --- but has no closing --- line.',
    });
    result.body = '';
    result.bodyStartLine = lines.length + 1;
    return result;
  }
  result.closed = true;
  const yamlLines = lines.slice(1, end);
  result.body = lines.slice(end + 1).join('\n');
  result.bodyStartLine = end + 2;

  const parsed = parseYaml(yamlLines, 2);
  result.data = parsed.value;
  result.keyLines = parsed.keyLines;
  result.errors.push(...parsed.errors);
  result.warnings.push(...parsed.warnings);
  return result;
}

/**
 * Parse a YAML document given as lines.
 * @param {string[]} lines
 * @param {number} firstLineNo 1-based line number of lines[0]
 */
function parseYaml(lines, firstLineNo) {
  const ctx = {
    lines: lines.slice(),
    base: firstLineNo,
    pos: 0,
    depth: 0,
    /** @type {YamlIssue[]} */ errors: [],
    /** @type {YamlIssue[]} */ warnings: [],
    /** @type {Record<string, number>} */ keyLines: {},
  };
  skipBlank(ctx);
  if (ctx.pos >= ctx.lines.length) {
    return { value: null, keyLines: ctx.keyLines, errors: ctx.errors, warnings: ctx.warnings };
  }
  const first = ctx.lines[ctx.pos];
  const ind = indentOf(first);
  let value;
  if (ind !== 0) {
    err(ctx, ctx.pos, 'yaml', 'Frontmatter must start at column 1 (unexpected indentation).');
  }
  const content = first.slice(ind);
  if (/^-( |$)/.test(content)) {
    value = parseSeq(ctx, ind);
  } else if (findMappingColon(content) !== -1) {
    value = parseMap(ctx, ind, true);
  } else {
    // A bare scalar document.
    const lineIdx = ctx.pos;
    ctx.pos++;
    value = parseInlineValue(ctx, content, -1, lineIdx);
  }
  skipBlank(ctx);
  if (ctx.pos < ctx.lines.length) {
    err(ctx, ctx.pos, 'yaml', 'Unexpected content; check the indentation.');
  }
  return { value, keyLines: ctx.keyLines, errors: ctx.errors, warnings: ctx.warnings };
}

function lineNo(ctx, idx) {
  return ctx.base + idx;
}
function err(ctx, idx, code, message) {
  ctx.errors.push({ line: lineNo(ctx, idx), code, message });
}
function warn(ctx, idx, code, message) {
  ctx.warnings.push({ line: lineNo(ctx, idx), code, message });
}

/** @param {string} line */
function indentOf(line) {
  const m = /^ */.exec(line);
  return m ? m[0].length : 0;
}
/** @param {string} line */
function isBlankOrComment(line) {
  return /^[ \t]*(#.*)?$/.test(line);
}
function skipBlank(ctx) {
  while (ctx.pos < ctx.lines.length && isBlankOrComment(ctx.lines[ctx.pos])) ctx.pos++;
}

/**
 * Index of the ':' that separates a mapping key from its value, or -1.
 * Handles quoted keys. The ':' must be followed by a space, a tab or end of line.
 * @param {string} content line content without leading indentation
 */
function findMappingColon(content) {
  let i = 0;
  if (content[0] === '"' || content[0] === "'") {
    const q = content[0];
    i = 1;
    while (i < content.length) {
      if (q === '"' && content[i] === '\\') {
        i += 2;
        continue;
      }
      if (content[i] === q) {
        if (q === "'" && content[i + 1] === "'") {
          i += 2;
          continue;
        }
        break;
      }
      i++;
    }
    if (i >= content.length) return -1;
    i++;
    while (content[i] === ' ' || content[i] === '\t') i++;
    if (content[i] === ':' && (i + 1 === content.length || /[ \t]/.test(content[i + 1]))) return i;
    return -1;
  }
  // Indicator characters cannot start a plain key ("-x" is fine, "- x" is a list item).
  if (/^[#?|>[\]{}&*!%@`,]/.test(content)) return -1;
  if (/^-([ \t]|$)/.test(content)) return -1;
  for (i = 0; i < content.length; i++) {
    const c = content[i];
    if (c === '#' && i > 0 && /[ \t]/.test(content[i - 1])) return -1;
    if (c === ':' && (i + 1 === content.length || /[ \t]/.test(content[i + 1]))) return i;
  }
  return -1;
}

/** @param {string} raw */
function unquoteKey(raw) {
  const k = raw.trim();
  if (k.length >= 2 && k[0] === '"' && k[k.length - 1] === '"') {
    return decodeDoubleQuoted(k.slice(1, -1)).value;
  }
  if (k.length >= 2 && k[0] === "'" && k[k.length - 1] === "'") {
    return k.slice(1, -1).replace(/''/g, "'");
  }
  return k;
}

function checkTabs(ctx, idx) {
  const line = ctx.lines[idx];
  if (/^ *\t/.test(line)) {
    err(ctx, idx, 'yaml', 'Tabs are not allowed for indentation in YAML.');
    return true;
  }
  return false;
}

/**
 * @param {any} ctx
 * @param {number} indent
 * @param {boolean} top true for the document's top-level mapping
 */
function parseMap(ctx, indent, top) {
  /** @type {Record<string, any>} */
  const obj = {};
  const seen = new Set();
  ctx.depth++;
  if (ctx.depth > 32) {
    err(ctx, ctx.pos, 'yaml', 'Frontmatter is nested too deeply.');
    ctx.pos = ctx.lines.length;
    ctx.depth--;
    return obj;
  }
  while (true) {
    skipBlank(ctx);
    if (ctx.pos >= ctx.lines.length) break;
    const idx = ctx.pos;
    const line = ctx.lines[idx];
    if (checkTabs(ctx, idx)) {
      ctx.pos++;
      continue;
    }
    const ind = indentOf(line);
    if (ind < indent) break;
    if (ind > indent) {
      err(ctx, idx, 'yaml', 'Unexpected indentation.');
      ctx.pos++;
      continue;
    }
    const content = line.slice(ind);
    if (/^-( |$)/.test(content)) {
      err(ctx, idx, 'yaml', 'A list item ("- ") cannot appear here; check the indentation.');
      ctx.pos++;
      continue;
    }
    const colon = findMappingColon(content);
    if (colon === -1) {
      err(ctx, idx, 'yaml', `Expected "key: value" but found "${truncate(content.trim(), 40)}".`);
      ctx.pos++;
      continue;
    }
    const key = unquoteKey(content.slice(0, colon));
    const rest = content.slice(colon + 1);
    ctx.pos++;
    if (seen.has(key)) {
      warn(
        ctx,
        idx,
        'yaml-duplicate-key',
        `Duplicate key "${key}". YAML parsers disagree on duplicates (some fail, some keep the last one).`
      );
    }
    seen.add(key);
    if (top) ctx.keyLines[key] = lineNo(ctx, idx);
    const value = parseValueAfterKey(ctx, rest, indent, idx);
    if (key === '__proto__') continue; // never write to the prototype
    obj[key] = value;
  }
  ctx.depth--;
  return obj;
}

/**
 * @param {any} ctx
 * @param {number} indent
 */
function parseSeq(ctx, indent) {
  /** @type {any[]} */
  const arr = [];
  ctx.depth++;
  if (ctx.depth > 32) {
    err(ctx, ctx.pos, 'yaml', 'Frontmatter is nested too deeply.');
    ctx.pos = ctx.lines.length;
    ctx.depth--;
    return arr;
  }
  while (true) {
    skipBlank(ctx);
    if (ctx.pos >= ctx.lines.length) break;
    const idx = ctx.pos;
    const line = ctx.lines[idx];
    if (checkTabs(ctx, idx)) {
      ctx.pos++;
      continue;
    }
    const ind = indentOf(line);
    if (ind < indent) break;
    const content = line.slice(ind);
    if (ind > indent) {
      err(ctx, idx, 'yaml', 'Unexpected indentation.');
      ctx.pos++;
      continue;
    }
    if (!/^-( |$)/.test(content)) break;
    const afterDash = content.slice(1);
    const spaces = indentOf(afterDash);
    const rest = afterDash.slice(spaces);
    if (rest === '' || /^#/.test(rest)) {
      ctx.pos++;
      skipBlank(ctx);
      if (ctx.pos < ctx.lines.length && indentOf(ctx.lines[ctx.pos]) > indent) {
        arr.push(parseNode(ctx, indent));
      } else {
        arr.push(null);
      }
      continue;
    }
    if (/^-( |$)/.test(rest) || (findMappingColon(rest) !== -1 && !/^["'[{]/.test(rest.trim()))) {
      // Nested node that starts on the dash line: re-indent the line in place.
      const newIndent = ind + 1 + spaces;
      ctx.lines[idx] = ' '.repeat(newIndent) + rest;
      if (/^-( |$)/.test(rest)) arr.push(parseSeq(ctx, newIndent));
      else arr.push(parseMap(ctx, newIndent, false));
      continue;
    }
    ctx.pos++;
    arr.push(parseInlineValue(ctx, rest, indent, idx));
  }
  ctx.depth--;
  return arr;
}

/** Parse the block node whose first line is at ctx.pos and indented more than parentIndent. */
function parseNode(ctx, parentIndent) {
  skipBlank(ctx);
  if (ctx.pos >= ctx.lines.length) return null;
  const line = ctx.lines[ctx.pos];
  const ind = indentOf(line);
  if (ind <= parentIndent) return null;
  const content = line.slice(ind);
  if (/^-( |$)/.test(content)) return parseSeq(ctx, ind);
  if (findMappingColon(content) !== -1) return parseMap(ctx, ind, false);
  const idx = ctx.pos;
  ctx.pos++;
  return parseInlineValue(ctx, content, parentIndent, idx);
}

/**
 * @param {any} ctx
 * @param {string} rest text after "key:"
 * @param {number} keyIndent
 * @param {number} keyIdx
 */
function parseValueAfterKey(ctx, rest, keyIndent, keyIdx) {
  const trimmed = rest.replace(/^[ \t]+/, '');
  if (trimmed === '' || trimmed[0] === '#') {
    const save = ctx.pos;
    skipBlank(ctx);
    if (ctx.pos >= ctx.lines.length) {
      ctx.pos = save;
      return null;
    }
    const next = ctx.lines[ctx.pos];
    const ind = indentOf(next);
    if (ind > keyIndent) return parseNode(ctx, keyIndent);
    if (ind === keyIndent && /^-( |$)/.test(next.slice(ind))) return parseSeq(ctx, keyIndent);
    ctx.pos = save;
    return null;
  }
  return parseInlineValue(ctx, trimmed, keyIndent, keyIdx);
}

const PLAIN_START_RESERVED = /^[@`]/;

/**
 * Parse a scalar or flow value that starts on line `idx` (already consumed).
 * Continuation lines must be indented more than ownerIndent.
 * @param {any} ctx
 * @param {string} text value text (no leading spaces)
 * @param {number} ownerIndent
 * @param {number} idx
 */
function parseInlineValue(ctx, text, ownerIndent, idx) {
  const c = text[0];
  if (c === '|' || c === '>') return parseBlockScalar(ctx, text, ownerIndent, idx);
  if (c === '"') return parseQuoted(ctx, text, ownerIndent, idx, '"');
  if (c === "'") return parseQuoted(ctx, text, ownerIndent, idx, "'");
  if (c === '[' || c === '{') return parseFlow(ctx, text, ownerIndent, idx);
  if (c === '&' || c === '*' || c === '!') {
    warn(
      ctx,
      idx,
      'yaml-unsupported',
      'YAML anchors, aliases and tags are not resolved by this extension; the raw text is shown.'
    );
    return stripComment(text).trim();
  }
  if (PLAIN_START_RESERVED.test(text)) {
    err(ctx, idx, 'yaml', `A value cannot start with "${c}" unless it is quoted.`);
    return stripComment(text).trim();
  }
  // Plain scalar, possibly multi-line.
  let value = stripComment(text).trim();
  let pendingBreaks = 0;
  while (ctx.pos < ctx.lines.length) {
    const line = ctx.lines[ctx.pos];
    if (/^[ \t]*$/.test(line)) {
      // Blank lines inside a multi-line plain scalar become newlines,
      // but only if more continuation text follows.
      let j = ctx.pos;
      while (j < ctx.lines.length && /^[ \t]*$/.test(ctx.lines[j])) j++;
      if (j < ctx.lines.length && indentOf(ctx.lines[j]) > ownerIndent && !isCommentLine(ctx.lines[j])) {
        pendingBreaks += j - ctx.pos;
        ctx.pos = j;
        continue;
      }
      break;
    }
    if (indentOf(line) <= ownerIndent) break;
    if (isCommentLine(line)) break;
    const part = stripComment(line).trim();
    value += pendingBreaks > 0 ? '\n'.repeat(pendingBreaks) + part : ' ' + part;
    pendingBreaks = 0;
    ctx.pos++;
  }
  if (/:([ \t]|$)/.test(value)) {
    err(
      ctx,
      idx,
      'yaml-colon',
      'Unquoted value contains ": ". Strict YAML parsers reject this; put the value in quotes.'
    );
  }
  return resolvePlain(value);
}

/** @param {string} line */
function isCommentLine(line) {
  return /^[ \t]*#/.test(line);
}

/** @param {string} text */
function stripComment(text) {
  const m = /(^|[ \t])#/.exec(text);
  return m ? text.slice(0, m.index) : text;
}

/**
 * YAML 1.2 core schema resolution for plain scalars.
 * @param {string} s
 */
function resolvePlain(s) {
  if (s === '' || s === '~' || s === 'null' || s === 'Null' || s === 'NULL') return null;
  if (s === 'true' || s === 'True' || s === 'TRUE') return true;
  if (s === 'false' || s === 'False' || s === 'FALSE') return false;
  if (/^[-+]?[0-9]+$/.test(s)) return Number(s);
  if (/^0x[0-9a-fA-F]+$/.test(s)) return parseInt(s.slice(2), 16);
  if (/^0o[0-7]+$/.test(s)) return parseInt(s.slice(2), 8);
  if (/^[-+]?(\.[0-9]+|[0-9]+(\.[0-9]*)?)([eE][-+]?[0-9]+)?$/.test(s)) return Number(s);
  if (/^[-+]?\.(inf|Inf|INF)$/.test(s)) return s[0] === '-' ? -Infinity : Infinity;
  if (/^\.(nan|NaN|NAN)$/.test(s)) return NaN;
  return s;
}

/**
 * @param {any} ctx
 * @param {string} header e.g. "|", ">-", "|2+"
 * @param {number} ownerIndent
 * @param {number} idx
 */
function parseBlockScalar(ctx, header, ownerIndent, idx) {
  const m = /^([|>])([+-]?)([1-9]?)([+-]?)[ \t]*(#.*)?$/.exec(header);
  if (!m) {
    err(ctx, idx, 'yaml', `Invalid block scalar header "${truncate(header, 20)}".`);
    return '';
  }
  const style = m[1];
  const chomp = m[2] || m[4] || '';
  const explicit = m[3] ? Number(m[3]) : 0;
  const base = ownerIndent < 0 ? 0 : ownerIndent;

  let contentIndent = explicit ? base + explicit : -1;
  /** @type {string[]} */
  const raw = [];
  while (ctx.pos < ctx.lines.length) {
    const line = ctx.lines[ctx.pos];
    if (/^ *$/.test(line)) {
      raw.push('');
      ctx.pos++;
      continue;
    }
    const ind = indentOf(line);
    if (contentIndent === -1) {
      if (ind <= ownerIndent) break;
      contentIndent = ind;
    }
    if (ind < contentIndent) break;
    raw.push(line.slice(contentIndent));
    ctx.pos++;
  }
  // Give back trailing blank lines that are followed by less-indented content:
  // they belong to the scalar only for chomping purposes, which we handle below.
  let trailing = 0;
  while (raw.length > 0 && raw[raw.length - 1] === '') {
    raw.pop();
    trailing++;
  }
  let textOut;
  if (style === '|') {
    textOut = raw.join('\n');
  } else {
    textOut = foldLines(raw);
  }
  if (raw.length === 0) {
    return chomp === '+' ? '\n'.repeat(trailing) : '';
  }
  if (chomp === '-') return textOut;
  if (chomp === '+') return textOut + '\n' + '\n'.repeat(trailing);
  return textOut + '\n';
}

/** @param {string[]} lines folded block content (no trailing empty lines) */
function foldLines(lines) {
  let out = '';
  let pending = 0;
  let prevMore = false;
  let first = true;
  for (const line of lines) {
    if (line === '') {
      pending++;
      continue;
    }
    const more = /^[ \t]/.test(line);
    if (first) {
      out += '\n'.repeat(pending);
    } else if (pending === 0) {
      out += more || prevMore ? '\n' : ' ';
    } else {
      out += '\n'.repeat(more || prevMore ? pending + 1 : pending);
    }
    out += line;
    pending = 0;
    prevMore = more;
    first = false;
  }
  return out;
}

/**
 * @param {string} s content between double quotes (raw, may contain escapes)
 * @returns {{ value: string, error: string | null }}
 */
function decodeDoubleQuoted(s) {
  let out = '';
  /** @type {string|null} */
  let error = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch !== '\\') {
      out += ch;
      continue;
    }
    const n = s[++i];
    switch (n) {
      case 'n': out += '\n'; break;
      case 't': case '\t': out += '\t'; break;
      case 'r': out += '\r'; break;
      case '0': out += '\0'; break;
      case 'a': out += '\x07'; break;
      case 'b': out += '\b'; break;
      case 'e': out += '\x1b'; break;
      case 'f': out += '\f'; break;
      case 'v': out += '\v'; break;
      case ' ': out += ' '; break;
      case '"': out += '"'; break;
      case '/': out += '/'; break;
      case '\\': out += '\\'; break;
      case 'N': out += '\u0085'; break;
      case '_': out += ' '; break;
      case 'L': out += ' '; break;
      case 'P': out += ' '; break;
      case 'x': case 'u': case 'U': {
        const len = n === 'x' ? 2 : n === 'u' ? 4 : 8;
        const hex = s.slice(i + 1, i + 1 + len);
        if (hex.length === len && /^[0-9a-fA-F]+$/.test(hex)) {
          const cp = parseInt(hex, 16);
          if (cp <= 0x10ffff) out += String.fromCodePoint(cp);
          else error = error || `Invalid escape "\\${n}${hex}".`;
          i += len;
        } else {
          error = error || `Invalid escape "\\${n}${hex}".`;
        }
        break;
      }
      default:
        error = error || `Invalid escape "\\${n === undefined ? '' : n}" in a double-quoted string.`;
        out += n === undefined ? '' : n;
    }
  }
  return { value: out, error };
}

/**
 * Quoted scalar that may span several lines.
 * @param {any} ctx
 * @param {string} text starts with the quote character
 * @param {number} ownerIndent
 * @param {number} idx
 * @param {'"'|"'"} q
 */
function parseQuoted(ctx, text, ownerIndent, idx, q) {
  // Collect raw characters up to the closing quote, folding line breaks.
  let raw = '';
  let line = text.slice(1);
  let closedAt = -1;
  let rest = '';
  while (true) {
    let i = 0;
    for (; i < line.length; i++) {
      const ch = line[i];
      if (q === '"' && ch === '\\') {
        if (i + 1 < line.length) {
          raw += ch + line[i + 1];
          i++;
          continue;
        }
        raw += '\\'; // escaped line break, handled at fold time
        continue;
      }
      if (ch === q) {
        if (q === "'" && line[i + 1] === "'") {
          raw += "''";
          i++;
          continue;
        }
        closedAt = i;
        break;
      }
      raw += ch;
    }
    if (closedAt !== -1) {
      rest = line.slice(closedAt + 1);
      break;
    }
    // Continue on the next line.
    if (ctx.pos >= ctx.lines.length) {
      err(ctx, idx, 'yaml', `Missing closing ${q === '"' ? 'double' : 'single'} quote.`);
      return finishQuoted(raw, q, ctx, idx);
    }
    const next = ctx.lines[ctx.pos];
    if (/^(---|\.\.\.)/.test(next)) {
      err(ctx, idx, 'yaml', `Missing closing ${q === '"' ? 'double' : 'single'} quote.`);
      return finishQuoted(raw, q, ctx, idx);
    }
    ctx.pos++;
    // Fold: trailing spaces of the previous line are dropped; one break becomes a space,
    // n empty lines become n newlines. An escaped break (\ at end) joins without a space.
    if (q === '"' && raw.endsWith('\\') && !raw.endsWith('\\\\')) {
      raw = raw.slice(0, -1);
      line = next.replace(/^[ \t]+/, '');
      continue;
    }
    raw = raw.replace(/[ \t]+$/, '');
    if (/^[ \t]*$/.test(next)) {
      raw += '\n';
      line = '';
      // Consume further empty lines.
      while (ctx.pos < ctx.lines.length && /^[ \t]*$/.test(ctx.lines[ctx.pos])) {
        raw += '\n';
        ctx.pos++;
      }
      if (ctx.pos < ctx.lines.length) {
        line = ctx.lines[ctx.pos].replace(/^[ \t]+/, '');
        ctx.pos++;
      }
      continue;
    }
    if (!raw.endsWith('\n')) raw += ' ';
    line = next.replace(/^[ \t]+/, '');
  }
  if (!/^[ \t]*(#.*)?$/.test(rest)) {
    err(ctx, idx, 'yaml', 'Unexpected text after the closing quote.');
  }
  return finishQuoted(raw, q, ctx, idx);
}

function finishQuoted(raw, q, ctx, idx) {
  if (q === "'") return raw.replace(/''/g, "'");
  const d = decodeDoubleQuoted(raw);
  if (d.error) err(ctx, idx, 'yaml', d.error);
  return d.value;
}

/**
 * Flow collection: [a, b] or {k: v}. May span several lines.
 * @param {any} ctx
 * @param {string} text
 * @param {number} ownerIndent
 * @param {number} idx
 */
function parseFlow(ctx, text, ownerIndent, idx) {
  let src = stripFlowComment(text);
  let guard = 0;
  while (!flowBalanced(src) && ctx.pos < ctx.lines.length && guard < 200) {
    const next = ctx.lines[ctx.pos];
    if (indentOf(next) <= ownerIndent && !/^[ \t]*$/.test(next)) break;
    src += ' ' + stripFlowComment(next.trim());
    ctx.pos++;
    guard++;
  }
  const p = { s: src, i: 0, error: /** @type {string|null} */ (null) };
  const value = flowValue(p);
  skipWs(p);
  if (!p.error && p.i < p.s.length) p.error = 'Unexpected text after a flow collection.';
  if (p.error) err(ctx, idx, 'yaml', p.error);
  return value;
}

/** Remove a trailing comment from a flow line (ignores # inside quotes). */
function stripFlowComment(line) {
  let q = '';
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (q === '"' && c === '\\') {
        i++;
        continue;
      }
      if (c === q) q = '';
      continue;
    }
    if (c === '"' || c === "'") q = c;
    else if (c === '#' && (i === 0 || /[ \t]/.test(line[i - 1]))) return line.slice(0, i);
  }
  return line;
}

function flowBalanced(s) {
  let depth = 0;
  let q = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (q === '"' && c === '\\') {
        i++;
        continue;
      }
      if (c === q) q = '';
      continue;
    }
    if (c === '"' || c === "'") q = c;
    else if (c === '[' || c === '{') depth++;
    else if (c === ']' || c === '}') depth--;
  }
  return depth <= 0 && !q;
}

function skipWs(p) {
  while (p.i < p.s.length && /[ \t]/.test(p.s[p.i])) p.i++;
}

function flowValue(p) {
  skipWs(p);
  const c = p.s[p.i];
  if (c === '[') {
    p.i++;
    const arr = [];
    skipWs(p);
    if (p.s[p.i] === ']') {
      p.i++;
      return arr;
    }
    while (p.i < p.s.length) {
      arr.push(flowValue(p));
      skipWs(p);
      if (p.s[p.i] === ',') {
        p.i++;
        skipWs(p);
        if (p.s[p.i] === ']') {
          p.i++;
          return arr;
        }
        continue;
      }
      if (p.s[p.i] === ']') {
        p.i++;
        return arr;
      }
      p.error = p.error || 'Expected "," or "]" in a flow sequence.';
      return arr;
    }
    p.error = p.error || 'Missing closing "]".';
    return arr;
  }
  if (c === '{') {
    p.i++;
    /** @type {Record<string, any>} */
    const obj = {};
    skipWs(p);
    if (p.s[p.i] === '}') {
      p.i++;
      return obj;
    }
    while (p.i < p.s.length) {
      const k = flowScalar(p, true);
      skipWs(p);
      let v = null;
      if (p.s[p.i] === ':') {
        p.i++;
        v = flowValue(p);
      }
      const key = String(k);
      if (key !== '__proto__') obj[key] = v;
      skipWs(p);
      if (p.s[p.i] === ',') {
        p.i++;
        skipWs(p);
        if (p.s[p.i] === '}') {
          p.i++;
          return obj;
        }
        continue;
      }
      if (p.s[p.i] === '}') {
        p.i++;
        return obj;
      }
      p.error = p.error || 'Expected "," or "}" in a flow mapping.';
      return obj;
    }
    p.error = p.error || 'Missing closing "}".';
    return obj;
  }
  return flowScalar(p, false);
}

function flowScalar(p, isKey) {
  skipWs(p);
  const c = p.s[p.i];
  if (c === '"' || c === "'") {
    const q = c;
    let j = p.i + 1;
    let raw = '';
    while (j < p.s.length) {
      const ch = p.s[j];
      if (q === '"' && ch === '\\') {
        raw += ch + (p.s[j + 1] || '');
        j += 2;
        continue;
      }
      if (ch === q) {
        if (q === "'" && p.s[j + 1] === "'") {
          raw += "''";
          j += 2;
          continue;
        }
        break;
      }
      raw += ch;
      j++;
    }
    if (j >= p.s.length) {
      p.error = p.error || 'Missing closing quote in a flow collection.';
      p.i = j;
      return raw;
    }
    p.i = j + 1;
    if (q === "'") return raw.replace(/''/g, "'");
    const d = decodeDoubleQuoted(raw);
    if (d.error) p.error = p.error || d.error;
    return d.value;
  }
  let j = p.i;
  while (j < p.s.length) {
    const ch = p.s[j];
    if (ch === ',' || ch === ']' || ch === '}' || ch === '[' || ch === '{') break;
    if (ch === ':' && (isKey || j + 1 >= p.s.length || /[ \t,\]}]/.test(p.s[j + 1]))) break;
    j++;
  }
  const raw = p.s.slice(p.i, j).trim();
  p.i = j;
  return isKey ? raw : resolvePlain(raw);
}

/** @param {string} s @param {number} n */
function truncate(s, n) {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

/**
 * Quote a string for safe use as a YAML scalar value on one line.
 * Plain style is used when it round-trips safely; otherwise double quotes.
 * @param {string} s
 */
function yamlQuote(s) {
  const plainSafe =
    s.length > 0 &&
    !/^[\s\-?:,[\]{}#&*!|>'"%@`]/.test(s) &&
    !/\s$/.test(s) &&
    !/:([ \t]|$)/.test(s) &&
    !/[ \t]#/.test(s) &&
    !/[\n\r\t\\]/.test(s) &&
    typeof resolvePlain(s) === 'string';
  if (plainSafe) return s;
  return (
    '"' +
    s
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\n/g, '\\n')
      .replace(/\r/g, '\\r')
      .replace(/\t/g, '\\t') +
    '"'
  );
}

module.exports = { parseFrontmatter, parseYaml, resolvePlain, yamlQuote, decodeDoubleQuoted };
