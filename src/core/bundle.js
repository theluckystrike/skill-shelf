// @ts-check
'use strict';

// Skill bundles: a .skill or .zip file that holds one or more skill folders.
// Claude's skill packager writes `<skill-name>/SKILL.md` plus the rest of the folder,
// and the same layout is what claude.ai accepts for upload. Export writes that layout.
// Install accepts it, a bundle with SKILL.md at the top level, and bundles with several skills.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { readZip, writeZip, ZipError, READ_LIMITS } = require('./zip');
const { planCopy, isSecretName, SkillOpError, COPY_LIMITS, newSkillNameError } = require('./fsops');
const { validateSkill, worstSeverity } = require('./validate');

const MAX_BUNDLE_FILE_BYTES = 50 * 1024 * 1024;

/** @param {string} p */
function existsNoFollow(p) {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Pack a skill folder into a bundle. Uses the same walk as Copy, so files that may hold
 * secrets, .git and symlinks that leave the skill are left out (and listed).
 * @param {string} skillDir
 * @param {typeof COPY_LIMITS} [limits]
 * @returns {{ buffer: Buffer, folder: string, files: number, bytes: number, skipped: string[] }}
 */
function exportSkill(skillDir, limits = COPY_LIMITS) {
  let real;
  try {
    real = fs.realpathSync(skillDir);
  } catch {
    throw new SkillOpError(`The skill folder does not exist: ${skillDir}`);
  }
  const folder = path.basename(skillDir);
  const plan = planCopy(real, limits);
  if (!plan.files.some((f) => f.rel === 'SKILL.md')) throw new SkillOpError(`"${folder}" has no SKILL.md, so it is not a skill bundle.`);
  const entries = plan.files.map((f) => {
    const abs = path.join(real, f.rel);
    return { name: `${folder}/${f.rel}`, data: fs.readFileSync(abs), mtime: fs.statSync(abs).mtime };
  });
  return { buffer: writeZip(entries), folder, files: plan.files.length, bytes: plan.bytes, skipped: plan.skipped };
}

/**
 * Check one archive path. Returns the cleaned path, or throws for paths that could
 * escape the target folder.
 * @param {string} raw
 */
function cleanEntryName(raw) {
  let n = raw.replace(/\\/g, '/');
  while (n.startsWith('./')) n = n.slice(2);
  if (n.includes('\0')) throw new ZipError(`The bundle has an unsafe file name: ${JSON.stringify(raw)}`);
  if (n.startsWith('/') || /^[A-Za-z]:/.test(n)) throw new ZipError(`The bundle has an absolute path, which is not allowed: ${raw}`);
  const parts = n.split('/');
  const isDir = n.endsWith('/');
  if (isDir) parts.pop();
  for (const s of parts) {
    if (s === '..') throw new ZipError(`The bundle has a path that leaves its folder, which is not allowed: ${raw}`);
    if (s === '' || s === '.') throw new ZipError(`The bundle has a malformed path: ${raw}`);
  }
  return parts.join('/') + (isDir ? '/' : '');
}

/** A folder name that is safe as one path segment on macOS, Linux and Windows. @param {string} s */
function safeFolderName(s) {
  return s.length > 0 && s.length <= 128 && !s.startsWith('.') && !/[<>:"/\\|?*\x00-\x1f]/.test(s) && !/[. ]$/.test(s);
}

/**
 * @typedef {object} BundleSkill
 * @property {string} folder      folder name the skill gets in the target
 * @property {string} root        folder inside the bundle ('' for SKILL.md at the top)
 * @property {string} name        frontmatter name (or the folder name)
 * @property {string} description
 * @property {{ rel: string, size: number, read: () => Buffer }[]} files
 * @property {import('./validate').Problem[]} problems
 * @property {import('./validate').Severity | null} severity
 */

/**
 * Read a bundle and work out which skills it holds. Nothing is written.
 * @param {Buffer} buf
 * @param {{ bundleName?: string, limits?: typeof READ_LIMITS }} [opts]
 * @returns {{ skills: BundleSkill[], skipped: string[] }}
 */
function planBundle(buf, opts = {}) {
  const entries = readZip(buf, opts.limits || READ_LIMITS);
  /** @type {string[]} */
  const skipped = [];
  /** @type {{ name: string, size: number, read: () => Buffer }[]} */
  const files = [];
  for (const e of entries) {
    const name = cleanEntryName(e.name);
    if (e.dir) continue;
    const parts = name.split('/');
    const base = parts[parts.length - 1];
    if (parts[0] === '__MACOSX' || base === '.DS_Store' || base === 'Thumbs.db') continue;
    if (parts.includes('.git')) {
      skipped.push(`${name} (.git)`);
      continue;
    }
    if (e.symlink) {
      skipped.push(`${name} (symbolic link)`);
      continue;
    }
    if (isSecretName(base, false) || parts.slice(0, -1).some((d) => isSecretName(d, true))) {
      skipped.push(`${name} (may hold secrets)`);
      continue;
    }
    files.push({ name, size: e.size, read: e.read });
  }
  const seen = new Set();
  for (const f of files) {
    const key = f.name.toLowerCase();
    if (seen.has(key)) throw new ZipError(`The bundle lists "${f.name}" twice.`);
    seen.add(key);
  }

  // Skill roots: every folder that holds a SKILL.md, except folders inside another skill.
  const roots = files
    .filter((f) => /(^|\/)SKILL\.md$/.test(f.name))
    .map((f) => (f.name.includes('/') ? f.name.slice(0, f.name.lastIndexOf('/')) : ''))
    .sort((a, b) => a.split('/').length - b.split('/').length || (a < b ? -1 : 1));
  /** @type {string[]} */
  const kept = [];
  for (const r of roots) {
    if (kept.some((k) => k === '' || r.startsWith(k + '/'))) continue;
    kept.push(r);
  }
  if (kept.length === 0) {
    const lower = files.find((f) => /(^|\/)skill\.md$/i.test(f.name));
    throw new ZipError(
      lower
        ? `The bundle has "${lower.name}" but no file named exactly SKILL.md. Rename it and try again.`
        : 'The bundle has no SKILL.md, so it does not hold a skill.'
    );
  }

  /** @type {BundleSkill[]} */
  const skills = [];
  for (const root of kept) {
    const prefix = root ? root + '/' : '';
    const own = files
      .filter((f) => f.name.startsWith(prefix))
      .map((f) => ({ rel: f.name.slice(prefix.length), size: f.size, read: f.read }));
    if (own.length > COPY_LIMITS.maxFiles) throw new ZipError(`A skill in the bundle has more than ${COPY_LIMITS.maxFiles} files.`);
    const md = own.find((f) => f.rel === 'SKILL.md');
    const text = md && md.size <= 1024 * 1024 ? md.read().toString('utf8') : null;
    const relSet = new Set(own.map((f) => f.rel));
    const dirSet = new Set();
    for (const f of own) {
      const parts = f.rel.split('/');
      for (let i = 1; i < parts.length; i++) dirSet.add(parts.slice(0, i).join('/'));
    }
    let folder = root ? root.split('/').pop() || '' : '';
    const v0 = validateSkill({ dirName: folder || 'skill', skillMdName: 'SKILL.md', text, tooLarge: !text, exists: () => true });
    if (!folder) {
      // SKILL.md at the top of the bundle: name the folder after the skill, else after the file.
      const fromName = typeof v0.name === 'string' ? v0.name : '';
      const fromFile = String(opts.bundleName || '').replace(/\.(skill|zip)$/i, '');
      folder = fromName && !newSkillNameError(fromName) ? fromName : fromFile;
    }
    if (!safeFolderName(folder)) throw new ZipError(`The bundle would create a folder named ${JSON.stringify(folder)}, which is not a safe folder name.`);
    const v = validateSkill({
      dirName: folder,
      skillMdName: 'SKILL.md',
      text,
      tooLarge: !text,
      exists: (rel) => {
        const r = String(rel).replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '');
        return relSet.has(r) || dirSet.has(r);
      },
    });
    skills.push({
      folder,
      root,
      name: v.name && v.name !== '' ? v.name : folder,
      description: v.description || '',
      files: own,
      problems: v.problems,
      severity: worstSeverity(v.problems),
    });
  }
  for (const f of files) {
    if (!kept.some((k) => k === '' || f.name.startsWith(k + '/'))) skipped.push(`${f.name} (outside a skill folder)`);
  }
  const names = new Set();
  for (const s of skills) {
    if (names.has(s.folder.toLowerCase())) throw new ZipError(`The bundle has two skills named "${s.folder}".`);
    names.add(s.folder.toLowerCase());
  }
  return { skills, skipped };
}

/**
 * Write the planned skills into a skills folder. Refuses to overwrite: if any target folder
 * exists, nothing is written. Each skill is written to a temporary folder and renamed.
 * @param {BundleSkill[]} skills
 * @param {string} targetParent
 * @returns {{ dest: string, files: number }[]}
 */
function installBundle(skills, targetParent) {
  const clash = skills.filter((s) => existsNoFollow(path.join(targetParent, s.folder)));
  if (clash.length) {
    throw new SkillOpError(
      `${clash.map((s) => `"${s.folder}"`).join(', ')} already ${clash.length === 1 ? 'exists' : 'exist'} in ${targetParent}. Nothing was installed.`
    );
  }
  fs.mkdirSync(targetParent, { recursive: true });
  /** @type {{ dest: string, files: number }[]} */
  const done = [];
  for (const s of skills) {
    const dest = path.join(targetParent, s.folder);
    const tmp = path.join(targetParent, `.${s.folder}.install-${crypto.randomBytes(4).toString('hex')}`);
    try {
      fs.mkdirSync(tmp);
      for (const f of s.files) {
        const out = path.join(tmp, ...f.rel.split('/'));
        const rel = path.relative(tmp, out);
        if (rel.startsWith('..') || path.isAbsolute(rel)) throw new ZipError(`Unsafe path in the bundle: ${f.rel}`);
        fs.mkdirSync(path.dirname(out), { recursive: true });
        fs.writeFileSync(out, f.read(), { flag: 'wx', mode: 0o644 });
      }
      if (existsNoFollow(dest)) throw new SkillOpError(`"${s.folder}" already exists in ${targetParent}.`);
      fs.renameSync(tmp, dest);
      done.push({ dest, files: s.files.length });
    } catch (e) {
      fs.rmSync(tmp, { recursive: true, force: true });
      if (e instanceof SkillOpError || e instanceof ZipError) throw e;
      throw new SkillOpError(`Install failed: ${/** @type {any} */ (e).code || String(e)}`);
    }
  }
  return done;
}

/**
 * Read a bundle file from disk with a size check first.
 * @param {string} file
 */
function readBundleFile(file) {
  const st = fs.statSync(file);
  if (!st.isFile()) throw new ZipError(`${file} is not a file.`);
  if (st.size > MAX_BUNDLE_FILE_BYTES) throw new ZipError(`The bundle is larger than ${MAX_BUNDLE_FILE_BYTES / 1048576} MB.`);
  return fs.readFileSync(file);
}

module.exports = { exportSkill, planBundle, installBundle, readBundleFile, cleanEntryName, safeFolderName, MAX_BUNDLE_FILE_BYTES };
