// @ts-check
'use strict';

const path = require('path');

/**
 * Known skill folders. Paths were checked on 2026-11-05 against:
 *  - Claude Code docs (code.claude.com/docs/en/skills)
 *  - Codex docs (learn.chatgpt.com/docs/build-skills): .agents/skills (repo), ~/.agents/skills (user)
 *  - Cursor docs (cursor.com/docs/context/skills): .agents, .cursor, plus .claude/.codex compatibility folders
 *  - GitHub Copilot docs (docs.github.com/en/copilot/concepts/agents/about-agent-skills)
 *  - Devin Local docs (docs.devin.ai/desktop/cascade/skills): legacy .windsurf/skills
 *  - vercel-labs/skills docs/agents.md (install paths used by the `skills` CLI)
 *
 * `agents` lists the agents documented to read the folder. It is not exhaustive.
 */

/** @typedef {'project' | 'user'} Scope */
/**
 * @typedef {object} LocationDef
 * @property {string} id
 * @property {Scope} scope
 * @property {string} rel        path relative to the workspace folder (project) or home (user)
 * @property {string[]} agents   agents documented to read this folder
 * @property {string[]} cliAgents `skills` CLI --agent ids that install into this folder
 */

/** @type {readonly LocationDef[]} */
const LOCATION_DEFS = Object.freeze([
  // project scope
  { id: 'p-claude', scope: 'project', rel: '.claude/skills', agents: ['Claude Code', 'Cursor', 'GitHub Copilot'], cliAgents: ['claude-code'] },
  { id: 'p-agents', scope: 'project', rel: '.agents/skills', agents: ['Codex', 'Cursor', 'GitHub Copilot', 'Gemini CLI', 'OpenCode', 'Amp', 'Devin'], cliAgents: ['codex', 'cursor', 'github-copilot', 'gemini-cli', 'opencode'] },
  { id: 'p-cursor', scope: 'project', rel: '.cursor/skills', agents: ['Cursor'], cliAgents: [] },
  { id: 'p-github', scope: 'project', rel: '.github/skills', agents: ['GitHub Copilot'], cliAgents: [] },
  { id: 'p-codex', scope: 'project', rel: '.codex/skills', agents: ['Cursor (compatibility folder)'], cliAgents: [] },
  { id: 'p-windsurf', scope: 'project', rel: '.windsurf/skills', agents: ['Windsurf', 'Devin (legacy folder)'], cliAgents: ['windsurf'] },
  { id: 'p-devin', scope: 'project', rel: '.devin/skills', agents: ['Devin'], cliAgents: ['devin'] },
  { id: 'p-junie', scope: 'project', rel: '.junie/skills', agents: ['Junie'], cliAgents: ['junie'] },
  { id: 'p-roo', scope: 'project', rel: '.roo/skills', agents: ['Roo Code'], cliAgents: ['roo'] },
  { id: 'p-kiro', scope: 'project', rel: '.kiro/skills', agents: ['Kiro'], cliAgents: ['kiro-cli'] },
  { id: 'p-opencode', scope: 'project', rel: '.opencode/skills', agents: ['OpenCode'], cliAgents: [] },
  // user scope
  { id: 'u-claude', scope: 'user', rel: '.claude/skills', agents: ['Claude Code', 'Cursor'], cliAgents: ['claude-code'] },
  { id: 'u-agents', scope: 'user', rel: '.agents/skills', agents: ['Codex', 'Cursor', 'GitHub Copilot', 'Devin'], cliAgents: ['codex'] },
  { id: 'u-codex', scope: 'user', rel: '.codex/skills', agents: ['Codex (older versions)', 'Cursor (compatibility folder)'], cliAgents: [] },
  { id: 'u-cursor', scope: 'user', rel: '.cursor/skills', agents: ['Cursor'], cliAgents: ['cursor'] },
  { id: 'u-copilot', scope: 'user', rel: '.copilot/skills', agents: ['GitHub Copilot'], cliAgents: ['github-copilot'] },
  { id: 'u-windsurf', scope: 'user', rel: '.codeium/windsurf/skills', agents: ['Windsurf'], cliAgents: ['windsurf'] },
  { id: 'u-devin', scope: 'user', rel: '.config/devin/skills', agents: ['Devin'], cliAgents: ['devin'] },
  { id: 'u-gemini', scope: 'user', rel: '.gemini/skills', agents: ['Gemini CLI'], cliAgents: ['gemini-cli'] },
  { id: 'u-opencode', scope: 'user', rel: '.config/opencode/skills', agents: ['OpenCode'], cliAgents: ['opencode'] },
  { id: 'u-amp', scope: 'user', rel: '.config/agents/skills', agents: ['Amp'], cliAgents: ['amp'] },
  { id: 'u-amp2', scope: 'user', rel: '.config/amp/skills', agents: ['Amp'], cliAgents: [] },
  { id: 'u-junie', scope: 'user', rel: '.junie/skills', agents: ['Junie'], cliAgents: ['junie'] },
  { id: 'u-roo', scope: 'user', rel: '.roo/skills', agents: ['Roo Code'], cliAgents: ['roo'] },
  { id: 'u-kiro', scope: 'user', rel: '.kiro/skills', agents: ['Kiro'], cliAgents: ['kiro-cli'] },
]);

/**
 * Agents offered by "Install from GitHub". `id` is the `skills` CLI --agent value.
 * Project/user folders come from vercel-labs/skills docs/agents.md.
 */
const CLI_AGENTS = Object.freeze([
  { id: 'claude-code', label: 'Claude Code', project: '.claude/skills', user: '~/.claude/skills' },
  { id: 'codex', label: 'Codex', project: '.agents/skills', user: '~/.agents/skills' },
  { id: 'cursor', label: 'Cursor', project: '.agents/skills', user: '~/.cursor/skills' },
  { id: 'github-copilot', label: 'GitHub Copilot', project: '.agents/skills', user: '~/.copilot/skills' },
  { id: 'windsurf', label: 'Windsurf', project: '.windsurf/skills', user: '~/.codeium/windsurf/skills' },
  { id: 'gemini-cli', label: 'Gemini CLI', project: '.agents/skills', user: '~/.gemini/skills' },
  { id: 'opencode', label: 'OpenCode', project: '.agents/skills', user: '~/.config/opencode/skills' },
  { id: 'junie', label: 'Junie', project: '.junie/skills', user: '~/.junie/skills' },
  { id: 'roo', label: 'Roo Code', project: '.roo/skills', user: '~/.roo/skills' },
  { id: 'kiro-cli', label: 'Kiro CLI', project: '.kiro/skills', user: '~/.kiro/skills' },
]);

/**
 * @typedef {object} ResolvedLocation
 * @property {string} key         unique key (scope + absolute path)
 * @property {Scope} scope
 * @property {string} dir         absolute path of the skills folder
 * @property {string} disabledDir absolute path of the matching disabled folder
 * @property {string} display     short label, e.g. ".claude/skills" or "~/.claude/skills"
 * @property {string[]} agents
 * @property {string | null} folderName  workspace folder name for project scope
 * @property {string | null} folderPath  workspace folder path for project scope
 * @property {boolean} custom     added through the agentSkills.extraLocations setting
 */

/**
 * Folder that holds disabled skills for a skills folder: a hidden sibling, so no agent
 * scans it (".claude/skills" -> ".claude/.disabled-skills").
 * @param {string} dir absolute skills folder
 */
function disabledDirFor(dir) {
  const parent = path.dirname(dir);
  const base = path.basename(dir);
  return path.join(parent, `.disabled-${base}`);
}

/**
 * Expand "~" or "~/x" with the given home directory.
 * @param {string} p
 * @param {string} home
 */
function expandHome(p, home) {
  if (p === '~') return home;
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(home, p.slice(2));
  return p;
}

/**
 * Show a path with ~ for the home directory.
 * @param {string} abs
 * @param {string} home
 */
function tildify(abs, home) {
  if (!home) return abs;
  const rel = path.relative(home, abs);
  if (rel === '') return '~';
  if (!rel.startsWith('..') && !path.isAbsolute(rel)) return '~/' + rel.split(path.sep).join('/');
  return abs;
}

/**
 * Resolve all candidate skill folders.
 * @param {object} opts
 * @param {string} opts.home
 * @param {{ name: string, path: string }[]} opts.workspaceFolders
 * @param {string[]} [opts.extraLocations] absolute, "~/..." (user scope) or relative (per workspace folder)
 * @param {Record<string, string | undefined>} [opts.env] CLAUDE_CONFIG_DIR and CODEX_HOME add their skills folders
 * @returns {ResolvedLocation[]}
 */
function resolveLocations(opts) {
  const home = opts.home;
  /** @type {ResolvedLocation[]} */
  const out = [];
  const seen = new Set();
  /** @param {Omit<ResolvedLocation, 'key' | 'disabledDir'>} loc */
  const push = (loc) => {
    const norm = path.resolve(loc.dir);
    const key = `${loc.scope}:${norm}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ ...loc, dir: norm, key, disabledDir: disabledDirFor(norm) });
  };

  for (const folder of opts.workspaceFolders || []) {
    for (const def of LOCATION_DEFS) {
      if (def.scope !== 'project') continue;
      push({
        scope: 'project',
        dir: path.join(folder.path, def.rel),
        display: def.rel,
        agents: def.agents.slice(),
        folderName: folder.name,
        folderPath: folder.path,
        custom: false,
      });
    }
  }
  if (home) {
    for (const def of LOCATION_DEFS) {
      if (def.scope !== 'user') continue;
      push({
        scope: 'user',
        dir: path.join(home, def.rel),
        display: '~/' + def.rel,
        agents: def.agents.slice(),
        folderName: null,
        folderPath: null,
        custom: false,
      });
    }
  }
  // Agents that move their home folder with an environment variable: Claude Code (CLAUDE_CONFIG_DIR) and Codex (CODEX_HOME).
  const env = opts.env || {};
  for (const [name, agent] of [['CLAUDE_CONFIG_DIR', 'Claude Code'], ['CODEX_HOME', 'Codex']]) {
    const v = typeof env[name] === 'string' ? env[name].trim() : '';
    if (!v || !path.isAbsolute(v) || v.length > 1024 || v.includes('\0')) continue;
    const abs = path.join(path.resolve(v), 'skills');
    push({
      scope: 'user',
      dir: abs,
      display: tildify(abs, home),
      agents: [`${agent} (${name})`],
      folderName: null,
      folderPath: null,
      custom: false,
    });
  }
  for (const raw of opts.extraLocations || []) {
    if (typeof raw !== 'string') continue;
    const p = raw.trim();
    if (p === '' || p.length > 1024 || p.includes('\0')) continue;
    if (p === '~' || p.startsWith('~/') || p.startsWith('~\\') || path.isAbsolute(p)) {
      if (!home && p.startsWith('~')) continue;
      const abs = expandHome(p, home);
      push({
        scope: 'user',
        dir: abs,
        display: tildify(path.resolve(abs), home),
        agents: ['Custom location'],
        folderName: null,
        folderPath: null,
        custom: true,
      });
    } else {
      for (const folder of opts.workspaceFolders || []) {
        const abs = path.resolve(folder.path, p);
        const rel = path.relative(folder.path, abs);
        if (rel.startsWith('..') || path.isAbsolute(rel)) continue; // stay inside the folder
        push({
          scope: 'project',
          dir: abs,
          display: rel.split(path.sep).join('/'),
          agents: ['Custom location'],
          folderName: folder.name,
          folderPath: folder.path,
          custom: true,
        });
      }
    }
  }
  return out;
}

module.exports = { LOCATION_DEFS, CLI_AGENTS, resolveLocations, disabledDirFor, expandHome, tildify };
