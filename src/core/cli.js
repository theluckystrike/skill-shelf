// @ts-check
'use strict';

const path = require('path');
const { CLI_AGENTS } = require('./locations');

/**
 * Helpers for "Install from GitHub" through the `skills` CLI (vercel-labs/skills).
 * The extension never starts the CLI. It builds the command, shows it in a modal dialog,
 * and copies it or types it into a terminal without pressing Enter; the user runs it.
 * Inputs are restricted to a strict character set, so the command line cannot carry
 * shell metacharacters in any shell (sh, PowerShell or cmd.exe).
 */

const MAX_SOURCE_LENGTH = 300;
const SEGMENT = '[A-Za-z0-9](?:[A-Za-z0-9._-]{0,99})';
const REF = '[A-Za-z0-9][A-Za-z0-9._/-]{0,199}';

const SHORTHAND_RE = new RegExp(`^(${SEGMENT})/(${SEGMENT})(?:@(${REF}))?$`);
const URL_RE = new RegExp(
  `^https://github\\.com/(${SEGMENT})/(${SEGMENT})(?:\\.git)?(?:/tree/(${REF}))?/?$`
);
const SKILL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/**
 * Validate a GitHub source for `skills add`.
 * Accepts "owner/repo", "owner/repo@ref", "https://github.com/owner/repo" and
 * "https://github.com/owner/repo/tree/<ref>/<path>".
 * @param {string} input
 * @returns {{ ok: true, value: string } | { ok: false, error: string }}
 */
function validateSource(input) {
  if (typeof input !== 'string') return { ok: false, error: 'Enter a GitHub repository.' };
  const s = input.trim();
  if (s === '') return { ok: false, error: 'Enter a GitHub repository, e.g. vercel-labs/agent-skills.' };
  if (s.length > MAX_SOURCE_LENGTH) return { ok: false, error: `Keep it under ${MAX_SOURCE_LENGTH} characters.` };
  const m = SHORTHAND_RE.exec(s) || URL_RE.exec(s);
  if (!m) {
    return {
      ok: false,
      error: 'Use owner/repo, owner/repo@tag, or a https://github.com/owner/repo URL (letters, digits, . _ - / only).',
    };
  }
  const parts = [m[1], m[2], m[3] || ''];
  if (parts.some((p) => p.split('/').some((seg) => seg === '..' || seg === '.'))) {
    return { ok: false, error: 'Path segments "." and ".." are not allowed.' };
  }
  return { ok: true, value: s.replace(/\/$/, '') };
}

/**
 * Validate a list of skill names typed by the user (comma or space separated).
 * @param {string} input
 * @returns {{ ok: true, value: string[] } | { ok: false, error: string }}
 */
function parseSkillNames(input) {
  const names = String(input || '')
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (names.length > 50) return { ok: false, error: 'Enter at most 50 skill names.' };
  for (const n of names) {
    if (!SKILL_NAME_RE.test(n)) {
      return { ok: false, error: `"${n}" is not a valid skill name (letters, digits, . _ - only).` };
    }
  }
  return { ok: true, value: [...new Set(names)] };
}

/**
 * Build the argument list for `skills add`.
 * @param {object} o
 * @param {string} o.source validated source
 * @param {string[]} o.agents `skills` CLI agent ids
 * @param {boolean} o.global
 * @param {string[]} [o.skills]
 * @param {boolean} [o.listOnly] add --list (show skills without installing)
 * @param {boolean} [o.copy] add --copy (copy instead of symlink)
 * @returns {string[]}
 */
function buildAddArgs(o) {
  const v = validateSource(o.source);
  if (!v.ok) throw new Error(v.error);
  const args = ['add', v.value];
  if (o.listOnly) {
    args.push('--list');
    return args;
  }
  const known = new Set(CLI_AGENTS.map((a) => a.id));
  if (!Array.isArray(o.agents) || o.agents.length === 0) throw new Error('Choose at least one agent.');
  for (const a of o.agents) {
    if (!known.has(a)) throw new Error(`Unknown agent "${a}".`);
    args.push('-a', a);
  }
  for (const s of o.skills || []) {
    if (!SKILL_NAME_RE.test(s)) throw new Error(`Invalid skill name "${s}".`);
    args.push('--skill', s);
  }
  if (o.global) args.push('-g');
  if (o.copy) args.push('--copy');
  return args;
}

/**
 * Find an executable on PATH without running it.
 * @param {string} name
 * @param {object} env
 * @param {string | undefined} env.PATH
 * @param {string | undefined} [env.PATHEXT]
 * @param {NodeJS.Platform} platform
 * @param {(p: string) => boolean} isFile
 * @returns {string | null}
 */
function findOnPath(name, env, platform, isFile) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const sep = platform === 'win32' ? ';' : ':';
  const dirs = String(env.PATH || '')
    .split(sep)
    .map((d) => d.trim().replace(/^"(.*)"$/, '$1'))
    .filter((d) => d !== '' && p.isAbsolute(d));
  const exts =
    platform === 'win32'
      ? String(env.PATHEXT || '.COM;.EXE;.BAT;.CMD')
          .split(';')
          .map((e) => e.trim().toLowerCase())
          .filter((e) => e === '.exe' || e === '.cmd' || e === '.com' || e === '.bat')
      : [''];
  for (const d of dirs) {
    for (const e of exts) {
      const candidate = p.join(d, name + e);
      if (isFile(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * Decide how to run the CLI: an installed `skills` binary, else `npx -y skills`.
 * @param {{ skillsPath: string | null, npxPath: string | null }} found
 * @returns {{ program: string, prefix: string[], label: string } | null}
 */
function chooseRunner(found) {
  if (found.skillsPath) return { program: found.skillsPath, prefix: [], label: 'installed skills CLI' };
  if (found.npxPath) return { program: found.npxPath, prefix: ['-y', 'skills'], label: 'npx (downloads the skills package from npm)' };
  return null;
}

/**
 * Quote one argument for display (and for copy-paste into a shell).
 * @param {string} arg
 * @param {NodeJS.Platform} platform
 */
function quoteArg(arg, platform) {
  if (/^[A-Za-z0-9_\-./:@=+,]+$/.test(arg)) return arg;
  if (platform === 'win32') return '"' + arg.replace(/"/g, '""') + '"';
  return "'" + arg.replace(/'/g, "'\\''") + "'";
}

/**
 * Human-readable command line shown in the confirmation dialog.
 * @param {string} program
 * @param {string[]} args
 * @param {Record<string, string>} env extra environment variables
 * @param {NodeJS.Platform} platform
 */
function formatCommand(program, args, env, platform) {
  const cmd = [program, ...args].map((a) => quoteArg(a, platform)).join(' ');
  const keys = Object.keys(env);
  if (keys.length === 0) return cmd;
  if (platform === 'win32') {
    return keys.map((k) => `set ${k}=${env[k]}&&`).join(' ') + ' ' + cmd;
  }
  return keys.map((k) => `${k}=${quoteArg(env[k], platform)}`).join(' ') + ' ' + cmd;
}

module.exports = {
  validateSource,
  parseSkillNames,
  buildAddArgs,
  findOnPath,
  chooseRunner,
  quoteArg,
  formatCommand,
};
