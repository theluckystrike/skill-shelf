// @ts-check
'use strict';

const path = require('path');
const { parseFrontmatter } = require('./frontmatter');
const { extractFileRefs } = require('./links');

/**
 * Limits from the Agent Skills specification (agentskills.io/specification)
 * and its reference validator (agentskills/agentskills, skills-ref).
 */
const LIMITS = Object.freeze({
  nameMax: 64,
  descriptionMax: 1024,
  compatibilityMax: 500,
  bodyLinesRecommended: 500,
});

/** Fields defined by the specification. Others are agent-specific (allowed, reported as info). */
const SPEC_FIELDS = Object.freeze(['name', 'description', 'license', 'allowed-tools', 'metadata', 'compatibility']);

/** @typedef {'error' | 'warning' | 'info'} Severity */
/** @typedef {{ severity: Severity, code: string, message: string, line: number }} Problem */

/** Number of Unicode code points (the reference validator uses Python len()). */
function cpLength(s) {
  return [...s].length;
}

/**
 * Validate a skill name. Returns problems with line 0 (caller assigns lines).
 * @param {unknown} value
 * @param {string | null} dirName folder name, or null to skip the folder check
 * @returns {{ severity: Severity, code: string, message: string }[]}
 */
function checkName(value, dirName) {
  /** @type {{ severity: Severity, code: string, message: string }[]} */
  const out = [];
  if (typeof value !== 'string') {
    out.push({ severity: 'error', code: 'name-type', message: '"name" must be a text value.' });
    return out;
  }
  const name = value.trim().normalize('NFKC');
  if (name === '') {
    out.push({ severity: 'error', code: 'name-empty', message: '"name" must not be empty.' });
    return out;
  }
  const len = cpLength(name);
  if (len > LIMITS.nameMax) {
    out.push({
      severity: 'error',
      code: 'name-too-long',
      message: `"name" is ${len} characters; the limit is ${LIMITS.nameMax}.`,
    });
  }
  if (name !== name.toLowerCase()) {
    out.push({ severity: 'error', code: 'name-uppercase', message: '"name" must be lowercase.' });
  }
  if (name.startsWith('-') || name.endsWith('-')) {
    out.push({ severity: 'error', code: 'name-hyphen-edge', message: '"name" must not start or end with a hyphen.' });
  }
  if (name.includes('--')) {
    out.push({ severity: 'error', code: 'name-double-hyphen', message: '"name" must not contain "--".' });
  }
  if (!/^[\p{L}\p{N}-]+$/u.test(name)) {
    out.push({
      severity: 'error',
      code: 'name-chars',
      message: '"name" may only contain letters, digits and hyphens (no spaces, dots or underscores).',
    });
  }
  if (dirName !== null && dirName.normalize('NFKC') !== name) {
    out.push({
      severity: 'warning',
      code: 'name-dir-mismatch',
      message: `"name" is "${name}" but the folder is "${dirName}". The spec requires them to match.`,
    });
  }
  return out;
}

/**
 * Validate a description value.
 * @param {unknown} value
 */
function checkDescription(value) {
  /** @type {{ severity: Severity, code: string, message: string }[]} */
  const out = [];
  if (typeof value !== 'string') {
    out.push({ severity: 'error', code: 'description-type', message: '"description" must be a text value.' });
    return out;
  }
  if (value.trim() === '') {
    out.push({ severity: 'error', code: 'description-empty', message: '"description" must not be empty.' });
    return out;
  }
  const len = cpLength(value);
  if (len > LIMITS.descriptionMax) {
    out.push({
      severity: 'error',
      code: 'description-too-long',
      message: `"description" is ${len} characters; the limit is ${LIMITS.descriptionMax}.`,
    });
  }
  return out;
}

/**
 * @typedef {object} SkillInput
 * @property {string} dirName           folder name of the skill
 * @property {string | null} skillMdName  'SKILL.md', 'skill.md' or null when missing
 * @property {string | null} text       SKILL.md content (null when not read)
 * @property {boolean} [tooLarge]       SKILL.md exceeded the read cap
 * @property {boolean} [brokenSymlink]  the skill folder is a symlink whose target is missing
 * @property {string} [readError]       message when SKILL.md could not be read
 * @property {(relPath: string) => boolean} [exists]  checks a path relative to the skill folder
 */

/**
 * @typedef {object} ValidationResult
 * @property {Problem[]} problems
 * @property {string | null} name         frontmatter name if it is a string
 * @property {string | null} description  frontmatter description if it is a string
 * @property {any} data                   parsed frontmatter
 */

/**
 * Validate one skill folder.
 * @param {SkillInput} input
 * @returns {ValidationResult}
 */
function validateSkill(input) {
  /** @type {Problem[]} */
  const problems = [];
  /** @type {ValidationResult} */
  const res = { problems, name: null, description: null, data: null };

  if (input.brokenSymlink) {
    problems.push({
      severity: 'error',
      code: 'broken-symlink',
      message: 'The skill folder is a symbolic link whose target does not exist.',
      line: 1,
    });
    return res;
  }
  if (!input.skillMdName) {
    problems.push({ severity: 'error', code: 'no-skill-md', message: 'The folder has no SKILL.md file.', line: 1 });
    return res;
  }
  if (input.skillMdName !== 'SKILL.md') {
    problems.push({
      severity: 'warning',
      code: 'skill-md-case',
      message: `The file is named "${input.skillMdName}"; agents look for "SKILL.md" (uppercase). Case-sensitive file systems will not find it.`,
      line: 1,
    });
  }
  if (input.readError) {
    problems.push({ severity: 'error', code: 'read-error', message: input.readError, line: 1 });
    return res;
  }
  if (input.tooLarge) {
    problems.push({
      severity: 'error',
      code: 'too-large',
      message: 'SKILL.md is larger than 1 MB; it was not parsed.',
      line: 1,
    });
    return res;
  }
  const text = input.text || '';
  const fm = parseFrontmatter(text);
  if (!fm.hasFrontmatter) {
    problems.push({
      severity: 'error',
      code: 'no-frontmatter',
      message: 'SKILL.md must start with YAML frontmatter: a "---" line, name and description, then "---".',
      line: 1,
    });
    return res;
  }
  for (const e of fm.errors) problems.push({ severity: 'error', code: e.code, message: e.message, line: e.line });
  for (const w of fm.warnings) problems.push({ severity: 'warning', code: w.code, message: w.message, line: w.line });
  if (!fm.closed) return res;

  const data = fm.data;
  res.data = data;
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    problems.push({
      severity: 'error',
      code: 'frontmatter-not-map',
      message: 'Frontmatter must be a set of "key: value" lines.',
      line: 2,
    });
    return res;
  }
  const lineOf = (/** @type {string} */ key) => fm.keyLines[key] || 1;

  // name
  if (!Object.prototype.hasOwnProperty.call(data, 'name')) {
    problems.push({ severity: 'error', code: 'name-missing', message: 'Missing required field "name".', line: 1 });
  } else {
    for (const p of checkName(data.name, input.dirName)) problems.push({ ...p, line: lineOf('name') });
    if (typeof data.name === 'string') res.name = data.name.trim();
  }

  // description
  if (!Object.prototype.hasOwnProperty.call(data, 'description')) {
    problems.push({
      severity: 'error',
      code: 'description-missing',
      message: 'Missing required field "description". Agents use it to decide when to load the skill.',
      line: 1,
    });
  } else {
    for (const p of checkDescription(data.description)) problems.push({ ...p, line: lineOf('description') });
    if (typeof data.description === 'string') res.description = data.description.trim();
  }

  // compatibility
  if (Object.prototype.hasOwnProperty.call(data, 'compatibility')) {
    const c = data.compatibility;
    if (typeof c !== 'string') {
      problems.push({
        severity: 'error',
        code: 'compatibility-type',
        message: '"compatibility" must be a text value.',
        line: lineOf('compatibility'),
      });
    } else if (c.trim() === '') {
      problems.push({
        severity: 'error',
        code: 'compatibility-empty',
        message: '"compatibility" must not be empty when present.',
        line: lineOf('compatibility'),
      });
    } else if (cpLength(c) > LIMITS.compatibilityMax) {
      problems.push({
        severity: 'error',
        code: 'compatibility-too-long',
        message: `"compatibility" is ${cpLength(c)} characters; the limit is ${LIMITS.compatibilityMax}.`,
        line: lineOf('compatibility'),
      });
    }
  }

  // metadata
  if (Object.prototype.hasOwnProperty.call(data, 'metadata') && data.metadata !== null) {
    const md = data.metadata;
    if (typeof md !== 'object' || Array.isArray(md)) {
      problems.push({
        severity: 'warning',
        code: 'metadata-type',
        message: '"metadata" should be a mapping of keys to text values.',
        line: lineOf('metadata'),
      });
    } else {
      const nonString = Object.keys(md).filter((k) => typeof md[k] !== 'string');
      if (nonString.length > 0) {
        problems.push({
          severity: 'warning',
          code: 'metadata-value',
          message: `"metadata" values should be text; quote these: ${nonString.slice(0, 5).join(', ')}.`,
          line: lineOf('metadata'),
        });
      }
    }
  }

  // agent-specific fields
  const extra = Object.keys(data).filter((k) => !SPEC_FIELDS.includes(k));
  if (extra.length > 0) {
    problems.push({
      severity: 'info',
      code: 'extra-fields',
      message: `Fields outside the Agent Skills spec: ${extra.slice(0, 8).join(', ')}. Agent-specific fields are fine, but other agents ignore them.`,
      line: lineOf(extra[0]),
    });
  }

  // body
  const body = fm.body;
  if (body.trim() === '') {
    problems.push({
      severity: 'warning',
      code: 'body-empty',
      message: 'SKILL.md has no instructions after the frontmatter.',
      line: fm.bodyStartLine - 1,
    });
  } else {
    const bodyLines = body.replace(/\n+$/, '').split('\n').length;
    if (bodyLines > LIMITS.bodyLinesRecommended) {
      problems.push({
        severity: 'info',
        code: 'body-long',
        message: `The instructions are ${bodyLines} lines. The spec recommends under ${LIMITS.bodyLinesRecommended}; move detail into referenced files.`,
        line: fm.bodyStartLine,
      });
    }
  }

  // file references
  if (input.exists) {
    for (const ref of extractFileRefs(body, fm.bodyStartLine)) {
      const rel = path.posix.normalize(ref.target.replace(/\\/g, '/'));
      if (rel === '..' || rel.startsWith('../')) {
        problems.push({
          severity: 'info',
          code: 'ref-outside',
          message: `"${ref.target}" points outside the skill folder; it breaks when the skill is copied or installed elsewhere.`,
          line: ref.line,
        });
        continue;
      }
      if (!input.exists(rel)) {
        problems.push({
          severity: 'warning',
          code: 'ref-missing',
          message: `Referenced file "${ref.target}" does not exist in the skill folder.`,
          line: ref.line,
        });
      }
    }
  }
  return res;
}

/**
 * Highest severity in a problem list, or null.
 * @param {Problem[]} problems
 * @returns {Severity | null}
 */
function worstSeverity(problems) {
  if (problems.some((p) => p.severity === 'error')) return 'error';
  if (problems.some((p) => p.severity === 'warning')) return 'warning';
  if (problems.some((p) => p.severity === 'info')) return 'info';
  return null;
}

module.exports = { validateSkill, checkName, checkDescription, worstSeverity, LIMITS, SPEC_FIELDS };
