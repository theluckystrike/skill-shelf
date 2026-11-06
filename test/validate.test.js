'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateSkill, checkName, checkDescription, worstSeverity } = require('../src/core/validate');
const { extractFileRefs, normalizeTarget } = require('../src/core/links');

const codes = (problems) => problems.map((p) => p.code).sort();
const skill = (text, extra = {}) =>
  validateSkill({ dirName: 'pdf-tools', skillMdName: 'SKILL.md', text, exists: () => true, ...extra });

test('valid skill has no problems', () => {
  const r = skill('---\nname: pdf-tools\ndescription: Extract PDF text. Use for PDFs.\n---\n# PDF tools\nSteps.\n');
  assert.deepEqual(r.problems, []);
  assert.equal(r.name, 'pdf-tools');
  assert.equal(r.description, 'Extract PDF text. Use for PDFs.');
  assert.equal(worstSeverity(r.problems), null);
});

test('missing name and description are errors', () => {
  const r = skill('---\nlicense: MIT\n---\nbody');
  assert.deepEqual(codes(r.problems), ['description-missing', 'name-missing']);
  assert.equal(worstSeverity(r.problems), 'error');
});

test('no frontmatter is a single error', () => {
  const r = skill('# Just markdown');
  assert.deepEqual(codes(r.problems), ['no-frontmatter']);
});

test('missing SKILL.md', () => {
  const r = validateSkill({ dirName: 'x', skillMdName: null, text: null });
  assert.deepEqual(codes(r.problems), ['no-skill-md']);
});

test('lowercase skill.md gets a warning but is still validated', () => {
  const r = validateSkill({ dirName: 'x', skillMdName: 'skill.md', text: '---\nname: x\ndescription: d\n---\nbody' });
  assert.deepEqual(codes(r.problems), ['skill-md-case']);
});

test('broken symlink and oversize file', () => {
  assert.deepEqual(codes(validateSkill({ dirName: 'x', skillMdName: null, text: null, brokenSymlink: true }).problems), ['broken-symlink']);
  assert.deepEqual(codes(validateSkill({ dirName: 'x', skillMdName: 'SKILL.md', text: null, tooLarge: true }).problems), ['too-large']);
});

test('name rules: uppercase, edges, double hyphen, characters', () => {
  assert.deepEqual(codes(checkName('PDF-Tools', null)), ['name-uppercase']);
  assert.deepEqual(codes(checkName('-pdf', null)), ['name-hyphen-edge']);
  assert.deepEqual(codes(checkName('pdf-', null)), ['name-hyphen-edge']);
  assert.deepEqual(codes(checkName('pdf--tools', null)), ['name-double-hyphen']);
  assert.deepEqual(codes(checkName('pdf_tools', null)), ['name-chars']);
  assert.deepEqual(codes(checkName('pdf tools', null)), ['name-chars']);
  assert.deepEqual(codes(checkName('pdf-tools-2', null)), []);
});

test('name length: 64 is fine, 65 is too long', () => {
  assert.deepEqual(checkName('a'.repeat(64), null), []);
  const p = checkName('a'.repeat(65), null);
  assert.equal(p.length, 1);
  assert.equal(p[0].message, '"name" is 65 characters; the limit is 64.');
});

test('unicode lowercase letters are allowed in names (reference validator)', () => {
  assert.deepEqual(checkName('données-pdf', null), []);
  assert.deepEqual(codes(checkName('Données', null)), ['name-uppercase']);
});

test('name must match the folder (warning)', () => {
  const r = skill('---\nname: other-name\ndescription: d\n---\nbody');
  assert.deepEqual(codes(r.problems), ['name-dir-mismatch']);
  assert.equal(r.problems[0].severity, 'warning');
  assert.equal(r.problems[0].line, 2);
});

test('name and description of the wrong type', () => {
  const r = skill('---\nname: 123\ndescription: [a, b]\n---\nbody');
  assert.deepEqual(codes(r.problems), ['description-type', 'name-type']);
});

test('description length: 1024 is fine, 1025 is too long', () => {
  assert.deepEqual(checkDescription('d'.repeat(1024)), []);
  const p = checkDescription('d'.repeat(1025));
  assert.equal(p[0].code, 'description-too-long');
  assert.equal(p[0].message, '"description" is 1025 characters; the limit is 1024.');
});

test('description counts code points, not UTF-16 units', () => {
  assert.deepEqual(checkDescription('😀'.repeat(1024)), []);
});

test('empty description is an error with the right line', () => {
  const r = skill('---\nname: pdf-tools\ndescription: ""\n---\nbody');
  assert.deepEqual(codes(r.problems), ['description-empty']);
  assert.equal(r.problems[0].line, 3);
});

test('compatibility: 500 ok, 501 too long, empty string invalid', () => {
  const ok = skill(`---\nname: pdf-tools\ndescription: d\ncompatibility: ${'c'.repeat(500)}\n---\nb`);
  assert.deepEqual(ok.problems, []);
  const long = skill(`---\nname: pdf-tools\ndescription: d\ncompatibility: ${'c'.repeat(501)}\n---\nb`);
  assert.deepEqual(codes(long.problems), ['compatibility-too-long']);
  assert.equal(long.problems[0].line, 4);
  const empty = skill('---\nname: pdf-tools\ndescription: d\ncompatibility: ""\n---\nb');
  assert.deepEqual(codes(empty.problems), ['compatibility-empty']);
});

test('metadata must be a map of text values', () => {
  const r = skill('---\nname: pdf-tools\ndescription: d\nmetadata:\n  version: 1.0\n  author: me\n---\nb');
  assert.deepEqual(codes(r.problems), ['metadata-value']);
  assert.equal(r.problems[0].message, '"metadata" values should be text; quote these: version.');
  const list = skill('---\nname: pdf-tools\ndescription: d\nmetadata: [a]\n---\nb');
  assert.deepEqual(codes(list.problems), ['metadata-type']);
});

test('agent-specific fields are info, not warnings', () => {
  const r = skill('---\nname: pdf-tools\ndescription: d\ndisable-model-invocation: true\nallowed-tools: Read Grep\n---\nb');
  assert.deepEqual(codes(r.problems), ['extra-fields']);
  assert.equal(r.problems[0].severity, 'info');
  assert.equal(r.problems[0].line, 4);
  assert.equal(worstSeverity(r.problems), 'info');
});

test('empty body is a warning', () => {
  const r = skill('---\nname: pdf-tools\ndescription: d\n---\n\n');
  assert.deepEqual(codes(r.problems), ['body-empty']);
});

test('a body over 500 lines is an info note', () => {
  const body = Array.from({ length: 501 }, (_, i) => `line ${i}`).join('\n');
  const r = skill(`---\nname: pdf-tools\ndescription: d\n---\n${body}\n`);
  assert.deepEqual(codes(r.problems), ['body-long']);
  const ok = skill(`---\nname: pdf-tools\ndescription: d\n---\n${body.split('\n').slice(0, 500).join('\n')}\n`);
  assert.deepEqual(ok.problems, []);
});

test('missing referenced files are warnings with their line numbers', () => {
  const text = '---\nname: pdf-tools\ndescription: d\n---\n# T\nSee [guide](references/guide.md).\nRun `scripts/run.py`.\n';
  const present = new Set(['scripts/run.py']);
  const r = skill(text, { exists: (p) => present.has(p) });
  assert.deepEqual(codes(r.problems), ['ref-missing']);
  assert.equal(r.problems[0].line, 6);
  assert.equal(r.problems[0].message, 'Referenced file "references/guide.md" does not exist in the skill folder.');
});

test('references outside the skill folder are an info note', () => {
  const r = skill('---\nname: pdf-tools\ndescription: d\n---\nSee [x](../other/SKILL.md)\n', { exists: () => false });
  assert.deepEqual(codes(r.problems), ['ref-outside']);
  assert.equal(r.problems[0].severity, 'info');
});

test('YAML errors from the parser are reported as errors', () => {
  const r = skill('---\nname: pdf-tools\ndescription: Use when: asked\n---\nb');
  assert.deepEqual(codes(r.problems), ['yaml-colon']);
  assert.equal(r.problems[0].line, 3);
});

test('frontmatter that is a list is rejected', () => {
  const r = skill('---\n- a\n- b\n---\nb');
  assert.deepEqual(codes(r.problems), ['frontmatter-not-map']);
});

test('extractFileRefs: links, images, reference definitions, conventional paths', () => {
  const body = [
    'See [the guide](references/guide.md#setup) and ![d](assets/diagram.png "Diagram").',
    '[ref]: ./scripts/build.sh',
    'Run scripts/extract.py then read `references/api.md`.',
  ].join('\n');
  const refs = extractFileRefs(body, 10).map((r) => `${r.line}:${r.kind}:${r.target}`);
  assert.deepEqual(refs, [
    '10:link:references/guide.md',
    '10:link:assets/diagram.png',
    '11:link:./scripts/build.sh',
    '12:path:scripts/extract.py',
    '12:path:references/api.md',
  ]);
});

test('extractFileRefs ignores URLs, anchors, absolute paths, templates and code blocks', () => {
  const body = [
    '[a](https://x.com/a.md) [b](#section) [c](/etc/passwd) [d](~/x.md) [e]({{path}}) [f](mailto:a@b.c)',
    '```bash',
    'python scripts/inside_fence.py',
    '[g](missing.md)',
    '```',
    '`[h](not-a-link.md)`',
    'abc/scripts/nested.py is not a conventional path',
  ].join('\n');
  assert.deepEqual(extractFileRefs(body, 1), []);
});

test('normalizeTarget decodes and strips query/fragment', () => {
  assert.equal(normalizeTarget('<references/my%20file.md>'), 'references/my file.md');
  assert.equal(normalizeTarget('a.md?raw=1'), 'a.md');
  assert.equal(normalizeTarget('C:\\x.md'), null);
  assert.equal(normalizeTarget('#top'), null);
});
