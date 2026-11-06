'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const cli = require('../src/core/cli');

test('validateSource accepts shorthand, tags and GitHub URLs', () => {
  assert.deepEqual(cli.validateSource('vercel-labs/agent-skills'), { ok: true, value: 'vercel-labs/agent-skills' });
  assert.deepEqual(cli.validateSource('  owner/repo@v1.2.3 '), { ok: true, value: 'owner/repo@v1.2.3' });
  assert.deepEqual(cli.validateSource('https://github.com/o/r'), { ok: true, value: 'https://github.com/o/r' });
  assert.deepEqual(cli.validateSource('https://github.com/o/r/'), { ok: true, value: 'https://github.com/o/r' });
  assert.deepEqual(cli.validateSource('https://github.com/o/r.git'), { ok: true, value: 'https://github.com/o/r.git' });
  assert.deepEqual(cli.validateSource('https://github.com/vercel-labs/agent-skills/tree/main/skills/web-design'), {
    ok: true,
    value: 'https://github.com/vercel-labs/agent-skills/tree/main/skills/web-design',
  });
});

test('validateSource rejects shell metacharacters, other hosts and traversal', () => {
  for (const bad of [
    '',
    'just-one-part',
    'o/r; rm -rf ~',
    'o/r && echo',
    'o/$(whoami)',
    'o/r`x`',
    'o/r|x',
    '"o/r"',
    'http://github.com/o/r',
    'https://gitlab.com/o/r',
    'https://github.com.evil.com/o/r',
    'https://github.com/o/r/tree/main/../../x',
    'o/r@../x',
    '-o/r',
    'o/r --global',
    'git@github.com:o/r.git',
    'a/' + 'b'.repeat(300),
  ]) {
    assert.equal(cli.validateSource(bad).ok, false, `should reject ${JSON.stringify(bad)}`);
  }
});

test('parseSkillNames splits on commas and spaces and dedupes', () => {
  assert.deepEqual(cli.parseSkillNames('a, b c,,a'), { ok: true, value: ['a', 'b', 'c'] });
  assert.deepEqual(cli.parseSkillNames(''), { ok: true, value: [] });
  assert.equal(cli.parseSkillNames('ok, bad;name').ok, false);
  assert.equal(cli.parseSkillNames('*').ok, false);
});

test('buildAddArgs: project install for two agents and two skills', () => {
  assert.deepEqual(
    cli.buildAddArgs({ source: 'o/r', agents: ['claude-code', 'cursor'], global: false, skills: ['pdf', 'xlsx'] }),
    ['add', 'o/r', '-a', 'claude-code', '-a', 'cursor', '--skill', 'pdf', '--skill', 'xlsx']
  );
});

test('buildAddArgs: global install and --list mode', () => {
  assert.deepEqual(cli.buildAddArgs({ source: 'o/r', agents: ['codex'], global: true }), ['add', 'o/r', '-a', 'codex', '-g']);
  assert.deepEqual(cli.buildAddArgs({ source: 'o/r', agents: [], global: false, listOnly: true }), ['add', 'o/r', '--list']);
});

test('buildAddArgs rejects unknown agents, no agents and bad sources', () => {
  assert.throws(() => cli.buildAddArgs({ source: 'o/r', agents: ['evil; rm'], global: false }), /Unknown agent/);
  assert.throws(() => cli.buildAddArgs({ source: 'o/r', agents: [], global: false }), /at least one agent/);
  assert.throws(() => cli.buildAddArgs({ source: 'o/r;x', agents: ['codex'], global: false }), /Use owner\/repo/);
});

test('findOnPath on POSIX', () => {
  const files = new Set(['/usr/local/bin/npx', '/opt/bin/skills']);
  const isFile = (p) => files.has(p);
  assert.equal(cli.findOnPath('skills', { PATH: '/usr/bin:/opt/bin:/usr/local/bin' }, 'linux', isFile), '/opt/bin/skills');
  assert.equal(cli.findOnPath('npx', { PATH: '/usr/bin:/usr/local/bin' }, 'darwin', isFile), '/usr/local/bin/npx');
  assert.equal(cli.findOnPath('npx', { PATH: 'relative/bin:' }, 'linux', () => true), null);
  assert.equal(cli.findOnPath('npx', { PATH: undefined }, 'linux', () => true), null);
});

test('findOnPath on Windows uses PATHEXT and ignores .js/.ps1 launchers', () => {
  const files = new Set(['C:\\node\\npx.ps1', 'C:\\node\\npx.cmd']);
  const isFile = (p) => files.has(p);
  assert.equal(
    cli.findOnPath('npx', { PATH: 'C:\\Windows;"C:\\node"', PATHEXT: '.COM;.EXE;.PS1;.CMD' }, 'win32', isFile),
    'C:\\node\\npx.cmd'
  );
});

test('chooseRunner prefers an installed skills CLI over npx', () => {
  assert.deepEqual(cli.chooseRunner({ skillsPath: '/b/skills', npxPath: '/b/npx' }), {
    program: '/b/skills',
    prefix: [],
    label: 'installed skills CLI',
  });
  assert.deepEqual(cli.chooseRunner({ skillsPath: null, npxPath: '/b/npx' }).prefix, ['-y', 'skills']);
  assert.equal(cli.chooseRunner({ skillsPath: null, npxPath: null }), null);
});

test('formatCommand shows the exact command with quoting and env', () => {
  assert.equal(
    cli.formatCommand('/usr/local/bin/npx', ['-y', 'skills', 'add', 'o/r', '-a', 'claude-code', '-g'], {}, 'darwin'),
    '/usr/local/bin/npx -y skills add o/r -a claude-code -g'
  );
  assert.equal(
    cli.formatCommand('/Users/Jo Doe/bin/skills', ['add', 'o/r'], { DISABLE_TELEMETRY: '1' }, 'linux'),
    "DISABLE_TELEMETRY=1 '/Users/Jo Doe/bin/skills' add o/r"
  );
  assert.equal(
    cli.formatCommand('C:\\Program Files\\nodejs\\npx.cmd', ['-y', 'skills', 'add', 'o/r'], {}, 'win32'),
    '"C:\\Program Files\\nodejs\\npx.cmd" -y skills add o/r'
  );
});

test('quoteArg escapes single quotes for POSIX shells', () => {
  assert.equal(cli.quoteArg("it's", 'linux'), "'it'\\''s'");
  assert.equal(cli.quoteArg('plain-arg_1.0', 'linux'), 'plain-arg_1.0');
});
