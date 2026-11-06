// @ts-check
'use strict';

const fs = require('fs');
const path = require('path');
const { validateSkill, worstSeverity } = require('./validate');

const MAX_SKILL_MD_BYTES = 1024 * 1024;
const MAX_ENTRIES_PER_LOCATION = 1000;

/**
 * @typedef {object} SkillInfo
 * @property {string} dir            absolute skill folder
 * @property {string} dirName
 * @property {string | null} skillMd absolute SKILL.md path (null when missing)
 * @property {string} name           frontmatter name, or the folder name as fallback
 * @property {string} description    frontmatter description ('' when missing)
 * @property {boolean} disabled      lives in the location's disabled folder
 * @property {boolean} symlink       the skill folder itself is a symbolic link
 * @property {string | null} realDir resolved target for symlinks
 * @property {import('./validate').Problem[]} problems
 * @property {import('./validate').Severity | null} severity
 * @property {string} locationKey
 */

/**
 * List skills in one folder (enabled or disabled).
 * @param {string} root absolute folder that contains skill folders
 * @param {{ disabled: boolean, locationKey: string, fsImpl?: typeof fs }} opts
 * @returns {{ skills: SkillInfo[], truncated: boolean, error: string | null }}
 */
function scanFolder(root, opts) {
  const xfs = opts.fsImpl || fs;
  /** @type {SkillInfo[]} */
  const skills = [];
  let entries;
  try {
    entries = xfs.readdirSync(root, { withFileTypes: true });
  } catch (e) {
    const code = /** @type {any} */ (e).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return { skills, truncated: false, error: null };
    return { skills, truncated: false, error: `Cannot read ${root}: ${code || String(e)}` };
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  let truncated = false;
  let count = 0;
  for (const ent of entries) {
    if (ent.name.startsWith('.')) continue;
    if (!ent.isDirectory() && !ent.isSymbolicLink()) continue;
    if (count >= MAX_ENTRIES_PER_LOCATION) {
      truncated = true;
      break;
    }
    const dir = path.join(root, ent.name);
    const symlink = ent.isSymbolicLink();
    let realDir = null;
    let brokenSymlink = false;
    if (symlink) {
      try {
        const st = xfs.statSync(dir);
        if (!st.isDirectory()) continue; // symlink to a file: not a skill folder
        realDir = xfs.realpathSync(dir);
      } catch {
        brokenSymlink = true;
      }
    }
    count++;
    skills.push(readSkill(dir, { disabled: opts.disabled, locationKey: opts.locationKey, symlink, realDir, brokenSymlink, fsImpl: xfs }));
  }
  return { skills, truncated, error: null };
}

/**
 * True when `file` is a symbolic link whose target is outside the skill folder `dir`.
 * Such a SKILL.md could point at any file (for example a key or a .env file), so it is not read.
 * @param {typeof fs} xfs
 * @param {string} dir
 * @param {string} file
 */
function linksOutside(xfs, dir, file) {
  try {
    if (!xfs.lstatSync(file).isSymbolicLink()) return false;
    const realDir = xfs.realpathSync(dir);
    const rel = path.relative(realDir, xfs.realpathSync(file));
    return rel === '' || rel.startsWith('..') || path.isAbsolute(rel);
  } catch {
    return true;
  }
}

/**
 * Read and validate one skill folder.
 * @param {string} dir
 * @param {{ disabled: boolean, locationKey: string, symlink?: boolean, realDir?: string | null, brokenSymlink?: boolean, fsImpl?: typeof fs }} opts
 * @returns {SkillInfo}
 */
function readSkill(dir, opts) {
  const xfs = opts.fsImpl || fs;
  const dirName = path.basename(dir);
  /** @type {string | null} */
  let skillMdName = null;
  let text = null;
  let tooLarge = false;
  /** @type {string | undefined} */
  let readError;
  if (!opts.brokenSymlink) {
    let names = [];
    try {
      names = xfs.readdirSync(dir);
    } catch (e) {
      readError = `Cannot read the skill folder: ${/** @type {any} */ (e).code || String(e)}`;
    }
    if (names.includes('SKILL.md')) skillMdName = 'SKILL.md';
    else if (names.includes('skill.md')) skillMdName = 'skill.md';
    else {
      const other = names.find((n) => n.toLowerCase() === 'skill.md');
      if (other) skillMdName = other;
    }
    if (skillMdName && !readError) {
      const file = path.join(dir, skillMdName);
      try {
        const st = xfs.statSync(file);
        if (!st.isFile()) readError = `${skillMdName} is not a regular file.`;
        else if (linksOutside(xfs, dir, file)) {
          readError = `${skillMdName} is a symbolic link to a file outside the skill folder, so it was not read.`;
        }
        else if (st.size > MAX_SKILL_MD_BYTES) tooLarge = true;
        else text = xfs.readFileSync(file, 'utf8');
      } catch (e) {
        readError = `Cannot read ${skillMdName}: ${/** @type {any} */ (e).code || String(e)}`;
      }
    }
  }
  const base = opts.realDir || dir;
  const v = validateSkill({
    dirName,
    skillMdName,
    text,
    tooLarge,
    brokenSymlink: !!opts.brokenSymlink,
    readError,
    exists: (rel) => {
      try {
        xfs.statSync(path.join(base, rel));
        return true;
      } catch {
        return false;
      }
    },
  });
  return {
    dir,
    dirName,
    skillMd: skillMdName ? path.join(dir, skillMdName) : null,
    name: v.name && v.name !== '' ? v.name : dirName,
    description: v.description || '',
    disabled: opts.disabled,
    symlink: !!opts.symlink,
    realDir: opts.realDir || null,
    problems: v.problems,
    severity: worstSeverity(v.problems),
    locationKey: opts.locationKey,
  };
}

/**
 * Scan a resolved location: enabled skills plus disabled ones.
 * @param {import('./locations').ResolvedLocation} loc
 * @param {{ fsImpl?: typeof fs }} [opts]
 */
function scanLocation(loc, opts = {}) {
  const enabled = scanFolder(loc.dir, { disabled: false, locationKey: loc.key, fsImpl: opts.fsImpl });
  const disabled = scanFolder(loc.disabledDir, { disabled: true, locationKey: loc.key, fsImpl: opts.fsImpl });
  const xfs = opts.fsImpl || fs;
  let exists = false;
  try {
    exists = xfs.statSync(loc.dir).isDirectory();
  } catch {
    exists = false;
  }
  return {
    location: loc,
    exists,
    skills: [...enabled.skills, ...disabled.skills],
    truncated: enabled.truncated || disabled.truncated,
    errors: [enabled.error, disabled.error].filter(Boolean),
  };
}

module.exports = { scanFolder, readSkill, scanLocation, linksOutside, MAX_SKILL_MD_BYTES, MAX_ENTRIES_PER_LOCATION };
