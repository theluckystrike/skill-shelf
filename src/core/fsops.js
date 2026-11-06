// @ts-check
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { checkName, checkDescription } = require('./validate');
const { yamlQuote } = require('./frontmatter');

const COPY_LIMITS = Object.freeze({ maxFiles: 2000, maxBytes: 50 * 1024 * 1024, maxDepth: 20 });
const SKIP_ON_COPY = new Set(['.git', '.DS_Store']);

/**
 * Files and folders that usually hold secrets. Copy skips them so a key or token that sits
 * in a user skill folder does not end up in a project folder that is committed to git.
 */
const SECRET_DIRS = new Set(['.ssh', '.aws', '.gnupg', '.azure', '.kube', '.docker']);
const SECRET_FILE_RE =
  /^(?:\.env(?:\.(?!example$|sample$|template$|dist$)[^/]*)?|\.npmrc|\.netrc|\.pypirc|\.git-credentials|\.htpasswd|id_(?:rsa|dsa|ecdsa|ed25519)|credentials(?:\.json)?|secrets?\.(?:json|ya?ml|toml|env)|.*\.(?:pem|key|p12|pfx|jks|keystore|kdbx|ppk|asc|gpg))$/i;

/**
 * True when a file or folder name looks like it holds secrets.
 * @param {string} name
 * @param {boolean} isDir
 */
function isSecretName(name, isDir) {
  return isDir ? SECRET_DIRS.has(name.toLowerCase()) : SECRET_FILE_RE.test(name);
}

class SkillOpError extends Error {}

/**
 * True when `child` equals `parent` or is inside it.
 * @param {string} parent
 * @param {string} child
 */
function isInside(parent, child) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel));
}

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
 * realpath for a path that may not exist yet: resolves the nearest existing ancestor
 * and appends the rest, so symlinked parents (e.g. macOS /var -> /private/var) compare correctly.
 * @param {string} p
 */
function realpathLoose(p) {
  let cur = path.resolve(p);
  const rest = [];
  while (true) {
    try {
      return path.join(fs.realpathSync(cur), ...rest.reverse());
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return path.resolve(p);
      rest.push(path.basename(cur));
      cur = parent;
    }
  }
}

/**
 * Move a skill folder (or a symlink to one) to a new parent folder, keeping its name.
 * Used for disable (into the disabled folder) and enable (back).
 * Refuses to overwrite.
 * @param {string} skillDir
 * @param {string} targetParent
 * @returns {string} new path
 */
function moveSkill(skillDir, targetParent) {
  const name = path.basename(skillDir);
  const dest = path.join(targetParent, name);
  if (!existsNoFollow(skillDir)) throw new SkillOpError(`The skill folder no longer exists: ${skillDir}`);
  if (existsNoFollow(dest)) {
    throw new SkillOpError(`"${name}" already exists in ${targetParent}. Rename or remove one of them first.`);
  }
  fs.mkdirSync(targetParent, { recursive: true });
  try {
    fs.renameSync(skillDir, dest);
  } catch (e) {
    const code = /** @type {any} */ (e).code;
    if (code === 'EXDEV') {
      throw new SkillOpError('The source and target are on different drives; move the folder by hand.');
    }
    throw new SkillOpError(`Could not move the skill: ${code || String(e)}`);
  }
  return dest;
}

/**
 * Walk a skill folder for copying. Follows symlinks that stay inside the skill folder
 * (copies their content), skips symlinks that point outside it, .git and secret-looking
 * files, detects cycles and enforces COPY_LIMITS.
 * @param {string} src
 * @param {typeof COPY_LIMITS} [limits]
 * @returns {{ dirs: string[], files: { rel: string, size: number }[], bytes: number, skipped: string[] }}
 */
function planCopy(src, limits = COPY_LIMITS) {
  /** @type {string[]} */
  const dirs = [];
  /** @type {{ rel: string, size: number }[]} */
  const files = [];
  /** @type {string[]} */
  const skipped = [];
  let bytes = 0;
  const visited = new Set();
  let rootReal;
  try {
    rootReal = fs.realpathSync(src);
  } catch {
    throw new SkillOpError(`The skill folder does not exist: ${src}`);
  }

  /** @param {string} abs @param {string} rel @param {number} depth */
  const walk = (abs, rel, depth) => {
    if (depth > limits.maxDepth) throw new SkillOpError(`The skill folder is nested deeper than ${limits.maxDepth} levels.`);
    let real;
    try {
      real = fs.realpathSync(abs);
    } catch {
      skipped.push(rel || '.');
      return;
    }
    if (visited.has(real)) {
      skipped.push(rel);
      return;
    }
    visited.add(real);
    const entries = fs.readdirSync(abs, { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : 1));
    for (const ent of entries) {
      if (SKIP_ON_COPY.has(ent.name)) {
        skipped.push(rel ? `${rel}/${ent.name}` : ent.name);
        continue;
      }
      const childAbs = path.join(abs, ent.name);
      const childRel = rel ? `${rel}/${ent.name}` : ent.name;
      let st;
      try {
        st = fs.statSync(childAbs); // follows symlinks
      } catch {
        skipped.push(childRel); // broken symlink
        continue;
      }
      if (ent.isSymbolicLink()) {
        let target;
        try {
          target = fs.realpathSync(childAbs);
        } catch {
          skipped.push(childRel);
          continue;
        }
        if (!isInside(rootReal, target)) {
          skipped.push(`${childRel} (link outside the skill)`);
          continue;
        }
      }
      if (isSecretName(ent.name, st.isDirectory())) {
        skipped.push(`${childRel} (may hold secrets)`);
        continue;
      }
      if (st.isDirectory()) {
        dirs.push(childRel);
        walk(childAbs, childRel, depth + 1);
      } else if (st.isFile()) {
        files.push({ rel: childRel, size: st.size });
        bytes += st.size;
        if (files.length > limits.maxFiles) {
          throw new SkillOpError(`The skill has more than ${limits.maxFiles} files; copy it by hand.`);
        }
        if (bytes > limits.maxBytes) {
          throw new SkillOpError(`The skill is larger than ${Math.round(limits.maxBytes / 1048576)} MB; copy it by hand.`);
        }
      } else {
        skipped.push(childRel); // socket, fifo, device
      }
    }
  };
  walk(src, '', 0);
  return { dirs, files, bytes, skipped };
}

/**
 * Copy a skill folder into another skills folder. Writes to a temporary folder first,
 * then renames, so a failed copy leaves nothing behind. Refuses to overwrite.
 * @param {string} srcDir
 * @param {string} targetParent
 * @param {typeof COPY_LIMITS} [limits]
 * @returns {{ dest: string, files: number, bytes: number, skipped: string[] }}
 */
function copySkill(srcDir, targetParent, limits = COPY_LIMITS) {
  const name = path.basename(srcDir);
  const dest = path.join(targetParent, name);
  let realSrc;
  try {
    realSrc = fs.realpathSync(srcDir);
  } catch {
    throw new SkillOpError(`The skill folder does not exist: ${srcDir}`);
  }
  if (existsNoFollow(dest)) throw new SkillOpError(`"${name}" already exists in ${targetParent}.`);
  const realParent = realpathLoose(targetParent);
  if (isInside(realSrc, realParent)) throw new SkillOpError('Cannot copy a skill into itself.');
  const plan = planCopy(realSrc, limits);
  fs.mkdirSync(targetParent, { recursive: true });
  const tmp = path.join(targetParent, `.${name}.copy-${crypto.randomBytes(4).toString('hex')}`);
  try {
    fs.mkdirSync(tmp);
    for (const d of plan.dirs) fs.mkdirSync(path.join(tmp, d), { recursive: true });
    for (const f of plan.files) {
      fs.copyFileSync(path.join(realSrc, f.rel), path.join(tmp, f.rel), fs.constants.COPYFILE_EXCL);
    }
    if (existsNoFollow(dest)) throw new SkillOpError(`"${name}" already exists in ${targetParent}.`);
    fs.renameSync(tmp, dest);
  } catch (e) {
    fs.rmSync(tmp, { recursive: true, force: true });
    if (e instanceof SkillOpError) throw e;
    throw new SkillOpError(`Copy failed: ${/** @type {any} */ (e).code || String(e)}`);
  }
  return { dest, files: plan.files.length, bytes: plan.bytes, skipped: plan.skipped };
}

/**
 * SKILL.md template for a new skill.
 * @param {string} name
 * @param {string} description
 */
function skillTemplate(name, description) {
  return [
    '---',
    `name: ${yamlQuote(name)}`,
    `description: ${yamlQuote(description)}`,
    '---',
    '',
    `# ${name}`,
    '',
    '## When to use',
    '',
    '- Describe the situations where an agent should load this skill.',
    '',
    '## Instructions',
    '',
    '1. Step one.',
    '2. Step two.',
    '',
    '## Examples',
    '',
    '- Input: ...',
    '- Output: ...',
    '',
  ].join('\n');
}

/**
 * Validate a new skill name for the create command. Returns an error message or null.
 * @param {string} name
 */
function newSkillNameError(name) {
  const problems = checkName(name, null).filter((p) => p.severity === 'error');
  if (name.trim() !== name) return 'Remove leading or trailing spaces.';
  return problems.length ? problems[0].message : null;
}

/**
 * Validate a description for the create command. Returns an error message or null.
 * @param {string} description
 */
function newDescriptionError(description) {
  if (/[\r\n]/.test(description)) return 'Use a single line.';
  const problems = checkDescription(description).filter((p) => p.severity === 'error');
  return problems.length ? problems[0].message : null;
}

/**
 * Create <parent>/<name>/SKILL.md from the template.
 * @param {string} parent skills folder
 * @param {string} name
 * @param {string} description
 * @returns {string} path of the new SKILL.md
 */
function createSkill(parent, name, description) {
  const nameErr = newSkillNameError(name);
  if (nameErr) throw new SkillOpError(nameErr);
  const descErr = newDescriptionError(description);
  if (descErr) throw new SkillOpError(descErr);
  const dir = path.join(parent, name);
  if (existsNoFollow(dir)) throw new SkillOpError(`"${name}" already exists in ${parent}.`);
  fs.mkdirSync(parent, { recursive: true });
  fs.mkdirSync(dir);
  const file = path.join(dir, 'SKILL.md');
  fs.writeFileSync(file, skillTemplate(name, description), { flag: 'wx' });
  return file;
}

module.exports = {
  SkillOpError,
  COPY_LIMITS,
  isInside,
  isSecretName,
  realpathLoose,
  moveSkill,
  planCopy,
  copySkill,
  skillTemplate,
  createSkill,
  newSkillNameError,
  newDescriptionError,
};
