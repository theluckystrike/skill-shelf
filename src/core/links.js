// @ts-check
'use strict';

/**
 * Extract local file references from a SKILL.md body.
 *
 * Checked:
 *  - Markdown links and images with a relative target: [text](references/a.md), ![x](assets/a.png)
 *  - Reference definitions: [id]: scripts/run.sh
 *  - Paths under the spec's conventional folders (scripts/, references/, assets/)
 *    written in prose or inline code, e.g. `scripts/extract.py`.
 *
 * Not checked: URLs (any scheme), in-page anchors (#x), absolute paths, home paths (~),
 * templated targets ({{x}}, ${x}, <x>), and anything inside fenced code blocks.
 */

/** @typedef {{ target: string, line: number, kind: 'link' | 'path' }} FileRef */

const MAX_REFS = 500;
const CONVENTIONAL = /(?<![\w./-])((?:scripts|references|assets)\/[\w.-]+(?:\/[\w.-]+)*\.[A-Za-z0-9]+)(?![\w/-])/g;

/**
 * @param {string} body markdown after the frontmatter
 * @param {number} firstLine 1-based file line number of body line 0
 * @returns {FileRef[]}
 */
function extractFileRefs(body, firstLine) {
  /** @type {FileRef[]} */
  const refs = [];
  const seen = new Set();
  const lines = String(body).replace(/\r\n?/g, '\n').split('\n');
  /** @type {string | null} */
  let fence = null;

  for (let i = 0; i < lines.length && refs.length < MAX_REFS; i++) {
    const line = lines[i];
    const fenceMatch = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1];
      if (fence === null) {
        fence = marker;
        continue;
      }
      if (marker[0] === fence[0] && marker.length >= fence.length && /^ {0,3}[`~]+[ \t]*$/.test(line)) {
        fence = null;
        continue;
      }
    }
    if (fence !== null) continue;
    if (/^( {4}|\t)/.test(line) && (i === 0 || /^[ \t]*$/.test(lines[i - 1]) || /^( {4}|\t)/.test(lines[i - 1]))) {
      // Indented code block.
      continue;
    }
    const lineNo = firstLine + i;

    /** @param {string} raw @param {'link'|'path'} kind */
    const add = (raw, kind) => {
      const t = normalizeTarget(raw);
      if (t === null) return;
      const key = kind + '\0' + t + '\0' + lineNo;
      if (seen.has(key)) return;
      seen.add(key);
      refs.push({ target: t, line: lineNo, kind });
    };

    // Inline code spans are scanned for conventional paths only, then removed
    // so that link syntax inside them is not treated as a link.
    const codeSpans = [];
    const withoutCode = line.replace(/(`+)([\s\S]*?)\1/g, (_m, _ticks, inner) => {
      codeSpans.push(inner);
      return ' '.repeat(_m.length);
    });

    const refDef = /^ {0,3}\[[^\]]+\]:[ \t]*(<[^>]*>|\S+)/.exec(withoutCode);
    if (refDef) add(refDef[1], 'link');

    const linkRe = /!?\[(?:[^\]\\]|\\.)*\]\(\s*(<[^>]*>|[^()\s]+(?:\([^()\s]*\))?[^()\s]*)(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/g;
    let m;
    while ((m = linkRe.exec(withoutCode)) !== null) add(m[1], 'link');

    const linkStripped = withoutCode.replace(linkRe, (s) => ' '.repeat(s.length));
    for (const text of [linkStripped, ...codeSpans]) {
      CONVENTIONAL.lastIndex = 0;
      let c;
      while ((c = CONVENTIONAL.exec(text)) !== null) add(c[1], 'path');
    }
  }
  return refs;
}

/**
 * Normalize a link destination to a relative file path, or null when it is not
 * a local relative file reference we should check.
 * @param {string} raw
 * @returns {string | null}
 */
function normalizeTarget(raw) {
  let t = raw.trim();
  if (t.startsWith('<') && t.endsWith('>')) t = t.slice(1, -1).trim();
  if (t === '') return null;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(t)) return null; // http:, mailto:, file:, C: ...
  if (t.startsWith('#') || t.startsWith('//') || t.startsWith('/') || t.startsWith('\\')) return null;
  if (t.startsWith('~')) return null;
  if (/[{}$*<>|]/.test(t)) return null;
  t = t.replace(/[?#].*$/, '');
  if (t === '' || t === '.' || t === './') return null;
  try {
    t = decodeURIComponent(t);
  } catch {
    // keep the raw text
  }
  return t;
}

module.exports = { extractFileRefs, normalizeTarget };
