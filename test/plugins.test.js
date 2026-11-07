'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { scanPlugins, pluginSkillDirs, claudeConfigDir, enabledMap } = require('../src/core/plugins');
const { resolveLocations } = require('../src/core/locations');

/** Small fixtures (a few KB) in the OS temp folder, removed after each test. */
let tmp;
test.beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'asm-plugins-'));
});
test.afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function write(rel, content) {
  const p = path.join(tmp, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  return p;
}
const md = (name, desc = 'Does a thing. Use when asked.') => `---\nname: ${name}\ndescription: ${desc}\n---\n# ${name}\n`;

/** The layout Claude Code writes: installed_plugins.json version 2 with installPath per entry. */
function installed(plugins) {
  write('home/.claude/plugins/installed_plugins.json', JSON.stringify({ version: 2, plugins }));
}

test('lists skills of a user-scope plugin from <installPath>/skills', () => {
  const root = path.join(tmp, 'home/.claude/plugins/cache/mk/pdf-kit/1.2.0');
  write('home/.claude/plugins/cache/mk/pdf-kit/1.2.0/skills/pdf-forms/SKILL.md', md('pdf-forms'));
  write('home/.claude/plugins/cache/mk/pdf-kit/1.2.0/skills/pdf-merge/SKILL.md', md('pdf-merge'));
  write('home/.claude/plugins/cache/mk/pdf-kit/1.2.0/skills/notes/readme.txt', 'not a skill');
  write('home/.claude/plugins/cache/mk/pdf-kit/1.2.0/.claude-plugin/plugin.json', JSON.stringify({ name: 'pdf-kit', version: '1.2.0' }));
  installed({ 'pdf-kit@mk': [{ scope: 'user', installPath: root, version: '1.2.0' }] });
  write('home/.claude/settings.json', JSON.stringify({ enabledPlugins: { 'pdf-kit@mk': true } }));

  const r = scanPlugins({ home: path.join(tmp, 'home'), env: {}, workspaceFolders: [] });
  assert.equal(r.length, 1);
  const loc = r[0].location;
  assert.equal(loc.scope, 'plugin');
  assert.equal(loc.display, 'pdf-kit@mk');
  assert.equal(loc.readOnly, true);
  assert.equal(loc.plugin.name, 'pdf-kit');
  assert.equal(loc.plugin.marketplace, 'mk');
  assert.equal(loc.plugin.version, '1.2.0');
  assert.equal(loc.plugin.enabled, true);
  assert.deepEqual(r[0].skills.map((s) => s.name), ['pdf-forms', 'pdf-merge']);
  assert.ok(r[0].skills.every((s) => s.readOnly === true && s.plugin === 'pdf-kit' && s.problems.length === 0));
});

test('follows the "skills" paths in plugin.json, including nested category folders', () => {
  const base = 'home/.claude/plugins/cache/official/eng/1.0.0';
  const root = path.join(tmp, base);
  write(`${base}/skills/engineering/tdd/SKILL.md`, md('tdd'));
  write(`${base}/skills/engineering/review/SKILL.md`, md('review'));
  write(`${base}/skills/productivity/handoff/SKILL.md`, md('handoff'));
  write(`${base}/extra/one-skill/SKILL.md`, md('one-skill'));
  write(`${base}/.claude-plugin/plugin.json`, JSON.stringify({
    name: 'eng',
    skills: ['./skills/engineering/tdd', './skills/productivity', './extra/one-skill', '../../../../outside', '/etc'],
  }));
  installed({ 'eng@official': [{ scope: 'user', installPath: root }] });
  const r = scanPlugins({ home: path.join(tmp, 'home'), env: {}, workspaceFolders: [] });
  assert.equal(r.length, 1);
  // engineering/review is not listed in plugin.json and skills/engineering has no SKILL.md, so it is not a skill
  assert.deepEqual(r[0].skills.map((s) => s.name).sort(), ['handoff', 'one-skill', 'tdd']);
  assert.equal(r[0].location.plugin.enabled, null, 'not named in any settings file');
});

test('project-scope plugins show only for their own workspace folder', () => {
  const root = path.join(tmp, 'home/.claude/plugins/cache/m/proj-tool/1.0.0');
  write('home/.claude/plugins/cache/m/proj-tool/1.0.0/skills/proj-skill/SKILL.md', md('proj-skill'));
  const project = path.join(tmp, 'work/app');
  fs.mkdirSync(project, { recursive: true });
  installed({ 'proj-tool@m': [{ scope: 'project', projectPath: project, installPath: root }] });
  assert.equal(scanPlugins({ home: path.join(tmp, 'home'), env: {}, workspaceFolders: [] }).length, 0);
  assert.equal(scanPlugins({ home: path.join(tmp, 'home'), env: {}, workspaceFolders: [{ name: 'other', path: path.join(tmp, 'work/other') }] }).length, 0);
  const r = scanPlugins({ home: path.join(tmp, 'home'), env: {}, workspaceFolders: [{ name: 'app', path: project }] });
  assert.equal(r.length, 1);
  assert.equal(r[0].location.plugin.installScope, 'project');
});

test('enabledPlugins: project and local settings override the user file', () => {
  const project = path.join(tmp, 'work/app');
  write('home/.claude/settings.json', JSON.stringify({ enabledPlugins: { 'a@m': true, 'b@m': true } }));
  write('work/app/.claude/settings.json', JSON.stringify({ enabledPlugins: { 'a@m': false } }));
  write('work/app/.claude/settings.local.json', JSON.stringify({ enabledPlugins: { 'b@m': false, 'c@m': 'yes' } }));
  const m = enabledMap(fs, [
    path.join(tmp, 'home/.claude/settings.json'),
    path.join(project, '.claude/settings.json'),
    path.join(project, '.claude/settings.local.json'),
  ]);
  assert.equal(m.get('a@m'), false);
  assert.equal(m.get('b@m'), false);
  assert.equal(m.has('c@m'), false, 'non-boolean values are ignored');
});

test('a plugin turned off in settings is still listed, marked off', () => {
  const root = path.join(tmp, 'home/.claude/plugins/cache/m/off/1.0.0');
  write('home/.claude/plugins/cache/m/off/1.0.0/skills/s1/SKILL.md', md('s1'));
  installed({ 'off@m': [{ scope: 'user', installPath: root }] });
  write('home/.claude/settings.json', JSON.stringify({ enabledPlugins: { 'off@m': false } }));
  const r = scanPlugins({ home: path.join(tmp, 'home'), env: {}, workspaceFolders: [] });
  assert.equal(r[0].location.plugin.enabled, false);
});

test('an installPath outside the plugins folder is ignored', () => {
  write('elsewhere/skills/secret/SKILL.md', md('secret'));
  installed({ 'evil@m': [{ scope: 'user', installPath: path.join(tmp, 'elsewhere') }] });
  assert.deepEqual(scanPlugins({ home: path.join(tmp, 'home'), env: {}, workspaceFolders: [] }), []);
});

test('missing, broken or odd installed_plugins.json gives an empty list, never a throw', () => {
  const home = path.join(tmp, 'home');
  assert.deepEqual(scanPlugins({ home, env: {}, workspaceFolders: [] }), []);
  write('home/.claude/plugins/installed_plugins.json', '{ not json');
  assert.deepEqual(scanPlugins({ home, env: {}, workspaceFolders: [] }), []);
  write('home/.claude/plugins/installed_plugins.json', JSON.stringify({ plugins: [1, 2] }));
  assert.deepEqual(scanPlugins({ home, env: {}, workspaceFolders: [] }), []);
  write('home/.claude/plugins/installed_plugins.json', JSON.stringify({ plugins: { 'x@m': [null, 5, { installPath: 7 }] } }));
  assert.deepEqual(scanPlugins({ home, env: {}, workspaceFolders: [] }), []);
  assert.deepEqual(scanPlugins({ home: '', env: {}, workspaceFolders: [] }), []);
});

test('a plugin without skills is left out', () => {
  const root = path.join(tmp, 'home/.claude/plugins/cache/m/cmds/1.0.0');
  write('home/.claude/plugins/cache/m/cmds/1.0.0/commands/hello.md', '# hello');
  installed({ 'cmds@m': [{ scope: 'user', installPath: root }] });
  assert.deepEqual(scanPlugins({ home: path.join(tmp, 'home'), env: {}, workspaceFolders: [] }), []);
});

test('CLAUDE_CONFIG_DIR moves the plugins folder', () => {
  const cfg = path.join(tmp, 'alt-claude');
  const root = path.join(cfg, 'plugins/cache/m/p/1.0.0');
  write('alt-claude/plugins/cache/m/p/1.0.0/skills/alt-skill/SKILL.md', md('alt-skill'));
  write('alt-claude/plugins/installed_plugins.json', JSON.stringify({ version: 2, plugins: { 'p@m': [{ scope: 'user', installPath: root }] } }));
  assert.equal(claudeConfigDir('/h', { CLAUDE_CONFIG_DIR: cfg }), cfg);
  assert.equal(claudeConfigDir('/h', { CLAUDE_CONFIG_DIR: 'relative/path' }), path.join('/h', '.claude'));
  assert.equal(claudeConfigDir('/h', {}), path.join('/h', '.claude'));
  const r = scanPlugins({ home: path.join(tmp, 'home'), env: { CLAUDE_CONFIG_DIR: cfg }, workspaceFolders: [] });
  assert.deepEqual(r.map((x) => x.skills[0].name), ['alt-skill']);
});

test('a broken SKILL.md inside a plugin still shows, with its problems', () => {
  const root = path.join(tmp, 'home/.claude/plugins/cache/m/bad/1.0.0');
  write('home/.claude/plugins/cache/m/bad/1.0.0/skills/Bad_Name/SKILL.md', '---\nname: Bad_Name\ndescription: x\n---\nbody\n');
  installed({ 'bad@m': [{ scope: 'user', installPath: root }] });
  const r = scanPlugins({ home: path.join(tmp, 'home'), env: {}, workspaceFolders: [] });
  assert.equal(r[0].skills[0].severity, 'error');
});

test('pluginSkillDirs accepts a single string for "skills"', () => {
  write('p/custom/x/SKILL.md', md('x'));
  const dirs = pluginSkillDirs(fs, path.join(tmp, 'p'), { skills: './custom' });
  assert.deepEqual(dirs.map((d) => path.basename(d)), ['x']);
});

test('resolveLocations adds $CLAUDE_CONFIG_DIR/skills and $CODEX_HOME/skills as user folders', () => {
  const home = path.join(tmp, 'home');
  const locs = resolveLocations({
    home,
    env: { CLAUDE_CONFIG_DIR: path.join(tmp, 'cc'), CODEX_HOME: path.join(tmp, 'cx'), },
    workspaceFolders: [],
  });
  const cc = locs.find((l) => l.dir === path.join(tmp, 'cc', 'skills'));
  const cx = locs.find((l) => l.dir === path.join(tmp, 'cx', 'skills'));
  assert.ok(cc && cc.scope === 'user' && cc.agents[0] === 'Claude Code (CLAUDE_CONFIG_DIR)');
  assert.ok(cx && cx.scope === 'user' && cx.agents[0] === 'Codex (CODEX_HOME)');
  // a relative value is ignored; the default ~/.claude/skills is not listed twice
  const again = resolveLocations({ home, env: { CODEX_HOME: 'rel', CLAUDE_CONFIG_DIR: path.join(home, '.claude') }, workspaceFolders: [] });
  assert.equal(again.filter((l) => l.dir === path.join(home, '.claude', 'skills')).length, 1);
  assert.equal(again.some((l) => l.dir.endsWith(path.join('rel', 'skills'))), false);
});
