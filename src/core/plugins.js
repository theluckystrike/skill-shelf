// @ts-check
'use strict';

/**
 * Skills that come with installed Claude Code plugins.
 *
 * Claude Code records installed plugins in <config>/plugins/installed_plugins.json (config is
 * $CLAUDE_CONFIG_DIR or ~/.claude). Each entry has an installPath. A plugin's skills live in
 * <installPath>/skills/<skill>/SKILL.md, plus any folders listed in the "skills" field of
 * <installPath>/.claude-plugin/plugin.json. Whether a plugin is on comes from "enabledPlugins" in
 * the user, project and local settings files.
 *
 * Read-only: nothing here writes, moves or deletes a file. Plugin folders belong to Claude Code.
 */

const fs = require('fs');
const path = require('path');
const { readSkill } = require('./scan');

const MAX_JSON_BYTES = 2 * 1024 * 1024;
const MAX_PLUGINS = 200;
const MAX_SKILLS_PER_PLUGIN = 500;

/**
 * @param {typeof fs} xfs
 * @param {string} file
 * @returns {any}
 */
function readJson(xfs, file) {
  try {
    const st = xfs.statSync(file);
    if (!st.isFile() || st.size > MAX_JSON_BYTES) return null;
    return JSON.parse(xfs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  } catch {
    return null;
  }
}

/** @param {typeof fs} xfs @param {string} p */
function isDir(xfs, p) {
  try {
    return xfs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** @param {typeof fs} xfs @param {string} dir */
function hasSkillMd(xfs, dir) {
  try {
    return xfs.readdirSync(dir).some((n) => n.toLowerCase() === 'skill.md');
  } catch {
    return false;
  }
}

/** True when `child` is `parent` or inside it. @param {string} parent @param {string} child */
function inside(parent, child) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Claude Code's config folder: $CLAUDE_CONFIG_DIR when set, else ~/.claude.
 * @param {string} home
 * @param {Record<string, string | undefined>} env
 */
function claudeConfigDir(home, env) {
  const c = env && typeof env.CLAUDE_CONFIG_DIR === 'string' ? env.CLAUDE_CONFIG_DIR.trim() : '';
  if (c && path.isAbsolute(c)) return path.resolve(c);
  return home ? path.join(home, '.claude') : '';
}

/**
 * Merge "enabledPlugins" from settings files. Later files win, as in Claude Code
 * (user, then project, then local).
 * @param {typeof fs} xfs
 * @param {string[]} files
 * @returns {Map<string, boolean>}
 */
function enabledMap(xfs, files) {
  /** @type {Map<string, boolean>} */
  const m = new Map();
  for (const f of files) {
    const j = readJson(xfs, f);
    const ep = j && typeof j === 'object' ? j.enabledPlugins : null;
    if (!ep || typeof ep !== 'object' || Array.isArray(ep)) continue;
    for (const [k, v] of Object.entries(ep)) if (typeof v === 'boolean') m.set(k, v);
  }
  return m;
}

/**
 * Skill folders of one plugin: <root>/skills/* with a SKILL.md, plus the "skills" paths of plugin.json
 * (a path that holds a SKILL.md is one skill, otherwise its subfolders with a SKILL.md are).
 * Paths that leave the plugin folder are ignored.
 * @param {typeof fs} xfs
 * @param {string} root
 * @param {any} manifest
 * @returns {string[]}
 */
function pluginSkillDirs(xfs, root, manifest) {
  /** @type {string[]} */
  const out = [];
  const seen = new Set();
  /** @param {string} d */
  const add = (d) => {
    const n = path.resolve(d);
    if (seen.has(n) || out.length >= MAX_SKILLS_PER_PLUGIN) return;
    seen.add(n);
    out.push(n);
  };
  /** @param {string} folder */
  const addChildren = (folder) => {
    let names = [];
    try {
      names = xfs.readdirSync(folder).sort();
    } catch {
      return;
    }
    for (const n of names) {
      if (n.startsWith('.')) continue;
      const d = path.join(folder, n);
      if (isDir(xfs, d) && hasSkillMd(xfs, d)) add(d);
    }
  };
  addChildren(path.join(root, 'skills'));
  let extra = manifest && typeof manifest === 'object' ? manifest.skills : undefined;
  if (typeof extra === 'string') extra = [extra];
  if (Array.isArray(extra)) {
    for (const p of extra.slice(0, MAX_SKILLS_PER_PLUGIN)) {
      if (typeof p !== 'string' || p.trim() === '' || p.includes('\0') || path.isAbsolute(p)) continue;
      const abs = path.resolve(root, p);
      if (!inside(root, abs) || !isDir(xfs, abs)) continue;
      if (hasSkillMd(xfs, abs)) add(abs);
      else addChildren(abs);
    }
  }
  return out;
}

/**
 * @typedef {object} PluginInfo
 * @property {string} id          "name@marketplace" as Claude Code writes it
 * @property {string} name
 * @property {string} marketplace
 * @property {string} version
 * @property {string} installScope "user", "project" or "local"
 * @property {boolean | null} enabled true/false from enabledPlugins, null when no settings file names it
 * @property {string} root        installPath
 */

/**
 * Find installed Claude Code plugins that apply here and scan their skills.
 * User-scope plugins always apply. Project and local plugins apply when their projectPath is one of
 * the open workspace folders.
 * @param {object} opts
 * @param {string} opts.home
 * @param {Record<string, string | undefined>} [opts.env]
 * @param {{ name: string, path: string }[]} [opts.workspaceFolders]
 * @param {typeof fs} [opts.fsImpl]
 */
function scanPlugins(opts) {
  const xfs = opts.fsImpl || fs;
  const cfg = claudeConfigDir(opts.home, opts.env || {});
  if (!cfg) return [];
  const pluginsDir = path.join(cfg, 'plugins');
  const installed = readJson(xfs, path.join(pluginsDir, 'installed_plugins.json'));
  const plugins = installed && typeof installed === 'object' ? installed.plugins : null;
  if (!plugins || typeof plugins !== 'object' || Array.isArray(plugins)) return [];
  const folders = (opts.workspaceFolders || []).map((f) => path.resolve(f.path));
  const settingsFiles = [path.join(cfg, 'settings.json')];
  for (const f of folders) settingsFiles.push(path.join(f, '.claude', 'settings.json'), path.join(f, '.claude', 'settings.local.json'));
  const enabled = enabledMap(xfs, settingsFiles);

  const results = [];
  const seenRoots = new Set();
  let count = 0;
  for (const [id, entries] of Object.entries(plugins)) {
    if (count >= MAX_PLUGINS) break;
    const list = Array.isArray(entries) ? entries : entries && typeof entries === 'object' ? [entries] : [];
    for (const e of list) {
      if (!e || typeof e !== 'object' || typeof e.installPath !== 'string') continue;
      const scope = typeof e.scope === 'string' ? e.scope : 'user';
      if (scope !== 'user') {
        const pp = typeof e.projectPath === 'string' ? path.resolve(e.projectPath) : '';
        if (!pp || !folders.includes(pp)) continue;
      }
      const root = path.resolve(e.installPath);
      // Only folders inside Claude Code's plugins folder: a crafted file can't point the scan elsewhere.
      if (!inside(pluginsDir, root) || root === pluginsDir || seenRoots.has(root) || !isDir(xfs, root)) continue;
      seenRoots.add(root);
      count++;
      const at = id.lastIndexOf('@');
      const manifest = readJson(xfs, path.join(root, '.claude-plugin', 'plugin.json'));
      const name = (manifest && typeof manifest.name === 'string' && manifest.name) || (at > 0 ? id.slice(0, at) : id);
      /** @type {PluginInfo} */
      const plugin = {
        id,
        name,
        marketplace: at > 0 ? id.slice(at + 1) : '',
        version: typeof e.version === 'string' ? e.version : (manifest && typeof manifest.version === 'string' ? manifest.version : ''),
        installScope: scope,
        enabled: enabled.has(id) ? /** @type {boolean} */ (enabled.get(id)) : null,
        root,
      };
      const key = `plugin:${root}`;
      const dirs = pluginSkillDirs(xfs, root, manifest);
      if (dirs.length === 0) continue;
      const skills = dirs.map((d) => {
        const s = readSkill(d, { disabled: false, locationKey: key, fsImpl: xfs });
        return { ...s, plugin: plugin.name, readOnly: true };
      });
      results.push({
        location: {
          key,
          scope: /** @type {'plugin'} */ ('plugin'),
          dir: root,
          disabledDir: '',
          display: id,
          agents: ['Claude Code (plugin)'],
          folderName: null,
          folderPath: null,
          custom: false,
          readOnly: true,
          plugin,
        },
        exists: true,
        skills,
        truncated: dirs.length >= MAX_SKILLS_PER_PLUGIN,
        errors: [],
      });
    }
  }
  results.sort((a, b) => (a.location.display < b.location.display ? -1 : a.location.display > b.location.display ? 1 : 0));
  return results;
}

module.exports = { scanPlugins, pluginSkillDirs, claudeConfigDir, enabledMap, MAX_PLUGINS, MAX_SKILLS_PER_PLUGIN };
