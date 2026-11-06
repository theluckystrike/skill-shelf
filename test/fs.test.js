'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { resolveLocations, disabledDirFor, expandHome, tildify, LOCATION_DEFS } = require('../src/core/locations');
const { scanLocation, scanFolder } = require('../src/core/scan');
const fsops = require('../src/core/fsops');

/** Small fixtures (a few KB) in the OS temp folder, removed after each test. */
let tmp;
test.beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'asm-test-'));
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

test('resolveLocations with a fake HOME and one workspace folder', () => {
  const home = path.join(tmp, 'home');
  const ws = path.join(tmp, 'proj');
  const locs = resolveLocations({ home, workspaceFolders: [{ name: 'proj', path: ws }] });
  const claudeProject = locs.find((l) => l.scope === 'project' && l.display === '.claude/skills');
  assert.equal(claudeProject.dir, path.join(ws, '.claude', 'skills'));
  assert.equal(claudeProject.disabledDir, path.join(ws, '.claude', '.disabled-skills'));
  assert.equal(claudeProject.folderName, 'proj');
  const claudeUser = locs.find((l) => l.scope === 'user' && l.display === '~/.claude/skills');
  assert.equal(claudeUser.dir, path.join(home, '.claude', 'skills'));
  const windsurfUser = locs.find((l) => l.display === '~/.codeium/windsurf/skills');
  assert.ok(windsurfUser);
  const projectCount = LOCATION_DEFS.filter((d) => d.scope === 'project').length;
  const userCount = LOCATION_DEFS.filter((d) => d.scope === 'user').length;
  assert.equal(locs.length, projectCount + userCount);
});

test('resolveLocations: two folders, no home, extra locations, dedupe', () => {
  const a = path.join(tmp, 'a');
  const b = path.join(tmp, 'b');
  const home = path.join(tmp, 'h');
  const locs = resolveLocations({
    home,
    workspaceFolders: [{ name: 'a', path: a }, { name: 'b', path: b }],
    extraLocations: ['~/team-skills', 'packages/web/.claude/skills', '../escape/skills', '~/.claude/skills', '', 42],
  });
  const custom = locs.filter((l) => l.custom).map((l) => `${l.scope}:${l.display}`);
  assert.deepEqual(custom, ['user:~/team-skills', 'project:packages/web/.claude/skills', 'project:packages/web/.claude/skills']);
  // ~/.claude/skills is already a known location: no duplicate.
  assert.equal(locs.filter((l) => l.dir === path.join(home, '.claude', 'skills')).length, 1);
  // relative paths that escape the workspace folder are ignored
  assert.equal(locs.some((l) => l.dir.includes('escape')), false);
});

test('disabledDirFor, expandHome and tildify', () => {
  assert.equal(disabledDirFor(path.join('/r', '.agents', 'skills')), path.join('/r', '.agents', '.disabled-skills'));
  assert.equal(disabledDirFor(path.join('/r', 'my-skills')), path.join('/r', '.disabled-my-skills'));
  assert.equal(expandHome('~/x/y', '/home/u'), path.join('/home/u', 'x/y'));
  assert.equal(expandHome('/abs', '/home/u'), '/abs');
  assert.equal(tildify(path.join('/home/u', '.claude', 'skills'), '/home/u'), '~/.claude/skills');
  assert.equal(tildify('/other/place', '/home/u'), '/other/place');
});

test('scanFolder: missing folder is empty, not an error', () => {
  const r = scanFolder(path.join(tmp, 'nope'), { disabled: false, locationKey: 'k' });
  assert.deepEqual(r, { skills: [], truncated: false, error: null });
});

test('scanLocation finds enabled and disabled skills, skips hidden and files', () => {
  const ws = path.join(tmp, 'ws');
  write('ws/.claude/skills/alpha/SKILL.md', md('alpha'));
  write('ws/.claude/skills/beta/SKILL.md', md('beta'));
  write('ws/.claude/skills/.hidden/SKILL.md', md('hidden'));
  write('ws/.claude/skills/README.md', 'not a skill');
  write('ws/.claude/.disabled-skills/gamma/SKILL.md', md('gamma'));
  const [loc] = resolveLocations({ home: '', workspaceFolders: [{ name: 'ws', path: ws }] });
  assert.equal(loc.display, '.claude/skills');
  const r = scanLocation(loc);
  assert.equal(r.exists, true);
  assert.deepEqual(
    r.skills.map((s) => `${s.name}:${s.disabled}`),
    ['alpha:false', 'beta:false', 'gamma:true']
  );
  assert.deepEqual(r.skills[0].problems, []);
  assert.equal(r.skills[0].description, 'Does a thing. Use when asked.');
});

test('scan reports a folder without SKILL.md and falls back to the folder name', () => {
  write('s/empty-skill/notes.txt', 'x');
  const r = scanFolder(path.join(tmp, 's'), { disabled: false, locationKey: 'k' });
  assert.equal(r.skills.length, 1);
  assert.equal(r.skills[0].name, 'empty-skill');
  assert.equal(r.skills[0].skillMd, null);
  assert.equal(r.skills[0].severity, 'error');
});

test('scan checks file references against the real skill folder', () => {
  write('s/linky/SKILL.md', md('linky') + 'See [a](references/a.md) and [b](references/b.md).\n');
  write('s/linky/references/a.md', 'a');
  const r = scanFolder(path.join(tmp, 's'), { disabled: false, locationKey: 'k' });
  const p = r.skills[0].problems;
  assert.equal(p.length, 1);
  assert.equal(p[0].code, 'ref-missing');
  assert.equal(p[0].line, 6);
  assert.match(p[0].message, /references\/b\.md/);
});

test('scan follows a symlinked skill folder and flags a broken one', { skip: process.platform === 'win32' }, () => {
  write('store/real-skill/SKILL.md', md('real-skill'));
  fs.mkdirSync(path.join(tmp, 's'));
  fs.symlinkSync(path.join(tmp, 'store', 'real-skill'), path.join(tmp, 's', 'real-skill'));
  fs.symlinkSync(path.join(tmp, 'store', 'gone'), path.join(tmp, 's', 'gone'));
  const r = scanFolder(path.join(tmp, 's'), { disabled: false, locationKey: 'k' });
  const byName = Object.fromEntries(r.skills.map((s) => [s.dirName, s]));
  assert.equal(byName['real-skill'].symlink, true);
  assert.equal(byName['real-skill'].realDir, fs.realpathSync(path.join(tmp, 'store', 'real-skill')));
  assert.deepEqual(byName['real-skill'].problems, []);
  assert.equal(byName.gone.problems[0].code, 'broken-symlink');
});

test('moveSkill disables and enables, refusing to overwrite', () => {
  write('l/skills/alpha/SKILL.md', md('alpha'));
  const skills = path.join(tmp, 'l', 'skills');
  const disabled = disabledDirFor(skills);
  const moved = fsops.moveSkill(path.join(skills, 'alpha'), disabled);
  assert.equal(moved, path.join(tmp, 'l', '.disabled-skills', 'alpha'));
  assert.equal(fs.existsSync(path.join(moved, 'SKILL.md')), true);
  assert.equal(fs.existsSync(path.join(skills, 'alpha')), false);
  write('l/skills/alpha/SKILL.md', md('alpha')); // a new skill with the same name
  assert.throws(() => fsops.moveSkill(moved, skills), /already exists/);
  assert.equal(fs.existsSync(moved), true, 'nothing moved on conflict');
});

test('moveSkill on a missing folder throws a clear error', () => {
  assert.throws(() => fsops.moveSkill(path.join(tmp, 'nope'), path.join(tmp, 'x')), /no longer exists/);
});

test('copySkill copies nested files, skips .git, and leaves no temp folder', () => {
  write('a/skills/pdf/SKILL.md', md('pdf'));
  write('a/skills/pdf/scripts/run.py', 'print(1)\n');
  write('a/skills/pdf/.git/HEAD', 'ref');
  const target = path.join(tmp, 'b', 'skills');
  const res = fsops.copySkill(path.join(tmp, 'a', 'skills', 'pdf'), target);
  assert.equal(res.dest, path.join(target, 'pdf'));
  assert.equal(res.files, 2);
  assert.equal(res.bytes, Buffer.byteLength(md('pdf')) + 9);
  assert.deepEqual(res.skipped, ['.git']);
  assert.equal(fs.readFileSync(path.join(target, 'pdf', 'scripts', 'run.py'), 'utf8'), 'print(1)\n');
  assert.deepEqual(fs.readdirSync(target), ['pdf']);
});

test('copySkill refuses to overwrite and to copy into itself', () => {
  write('a/skills/pdf/SKILL.md', md('pdf'));
  write('b/skills/pdf/SKILL.md', md('pdf'));
  const src = path.join(tmp, 'a', 'skills', 'pdf');
  assert.throws(() => fsops.copySkill(src, path.join(tmp, 'b', 'skills')), /already exists/);
  assert.throws(() => fsops.copySkill(src, path.join(src, 'nested')), /into itself/);
});

test('copySkill enforces the file-count limit and cleans up', () => {
  for (let i = 0; i < 5; i++) write(`a/skills/many/f${i}.txt`, 'x');
  const target = path.join(tmp, 'b');
  assert.throws(
    () => fsops.copySkill(path.join(tmp, 'a', 'skills', 'many'), target, { maxFiles: 3, maxBytes: 1e9, maxDepth: 5 }),
    /more than 3 files/
  );
  assert.equal(fs.existsSync(path.join(target, 'many')), false);
});

test('copySkill dereferences a symlinked skill folder', { skip: process.platform === 'win32' }, () => {
  write('store/linked/SKILL.md', md('linked'));
  fs.mkdirSync(path.join(tmp, 'a'));
  fs.symlinkSync(path.join(tmp, 'store', 'linked'), path.join(tmp, 'a', 'linked'));
  const res = fsops.copySkill(path.join(tmp, 'a', 'linked'), path.join(tmp, 'b'));
  assert.equal(fs.lstatSync(res.dest).isSymbolicLink(), false);
  assert.equal(fs.readFileSync(path.join(res.dest, 'SKILL.md'), 'utf8'), md('linked'));
});

test('createSkill writes a valid SKILL.md that passes validation', () => {
  const parent = path.join(tmp, 'p', '.claude', 'skills');
  const file = fsops.createSkill(parent, 'release-notes', 'Writes release notes. Use when: a release is cut.');
  assert.equal(file, path.join(parent, 'release-notes', 'SKILL.md'));
  const text = fs.readFileSync(file, 'utf8');
  assert.ok(text.startsWith('---\nname: release-notes\ndescription: "Writes release notes. Use when: a release is cut."\n---\n'));
  const r = scanFolder(parent, { disabled: false, locationKey: 'k' });
  assert.deepEqual(r.skills[0].problems, []);
  assert.equal(r.skills[0].description, 'Writes release notes. Use when: a release is cut.');
});

test('createSkill rejects bad names, multi-line descriptions and existing folders', () => {
  const parent = path.join(tmp, 'skills');
  assert.throws(() => fsops.createSkill(parent, 'Bad Name', 'd'), /lowercase/);
  assert.throws(() => fsops.createSkill(parent, 'ok', 'two\nlines'), /single line/);
  assert.throws(() => fsops.createSkill(parent, 'ok', '   '), /must not be empty/);
  fsops.createSkill(parent, 'ok', 'd');
  assert.throws(() => fsops.createSkill(parent, 'ok', 'd'), /already exists/);
});

test('newSkillNameError messages', () => {
  assert.equal(fsops.newSkillNameError('good-name'), null);
  assert.equal(fsops.newSkillNameError(' good'), 'Remove leading or trailing spaces.');
  assert.equal(fsops.newSkillNameError(''), '"name" must not be empty.');
  assert.equal(fsops.newSkillNameError('a--b'), '"name" must not contain "--".');
});

test('isInside', () => {
  assert.equal(fsops.isInside('/a/b', '/a/b/c'), true);
  assert.equal(fsops.isInside('/a/b', '/a/b'), true);
  assert.equal(fsops.isInside('/a/b', '/a/bc'), false);
  assert.equal(fsops.isInside('/a/b', '/a'), false);
});
