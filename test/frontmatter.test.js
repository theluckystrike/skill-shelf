'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseFrontmatter, yamlQuote, resolvePlain } = require('../src/core/frontmatter');

const fm = (yaml, body = '# Body\n') => `---\n${yaml}\n---\n${body}`;

test('minimal frontmatter: name and description', () => {
  const r = parseFrontmatter(fm('name: pdf-tools\ndescription: Extract PDF text.'));
  assert.equal(r.hasFrontmatter, true);
  assert.equal(r.closed, true);
  assert.deepEqual(r.data, { name: 'pdf-tools', description: 'Extract PDF text.' });
  assert.deepEqual(r.keyLines, { name: 2, description: 3 });
  assert.equal(r.body, '# Body\n');
  assert.equal(r.bodyStartLine, 5);
  assert.deepEqual(r.errors, []);
});

test('no frontmatter: body is the whole file', () => {
  const r = parseFrontmatter('# Title\ntext');
  assert.equal(r.hasFrontmatter, false);
  assert.equal(r.data, null);
  assert.equal(r.body, '# Title\ntext');
  assert.equal(r.bodyStartLine, 1);
});

test('unclosed frontmatter is an error on line 1', () => {
  const r = parseFrontmatter('---\nname: x\ndescription: y\n');
  assert.equal(r.closed, false);
  assert.equal(r.errors.length, 1);
  assert.equal(r.errors[0].code, 'frontmatter-unclosed');
  assert.equal(r.errors[0].line, 1);
});

test('CRLF line endings and a BOM are accepted', () => {
  const r = parseFrontmatter('﻿---\r\nname: a\r\ndescription: b\r\n---\r\nbody');
  assert.deepEqual(r.data, { name: 'a', description: 'b' });
  assert.equal(r.body, 'body');
});

test('double-quoted value with escapes and an inner colon', () => {
  const r = parseFrontmatter(fm('name: x\ndescription: "Use when: the user says \\"hi\\"\\n"'));
  assert.equal(r.data.description, 'Use when: the user says "hi"\n');
  assert.deepEqual(r.errors, []);
});

test('single-quoted value with doubled quote', () => {
  const r = parseFrontmatter(fm("name: x\ndescription: 'It''s fine: really'"));
  assert.equal(r.data.description, "It's fine: really");
  assert.deepEqual(r.errors, []);
});

test('folded block scalar with strip chomping', () => {
  const r = parseFrontmatter(fm('name: x\ndescription: >-\n  Extract text\n  and tables.\n\n  New paragraph.'));
  assert.equal(r.data.description, 'Extract text and tables.\nNew paragraph.');
});

test('literal block scalar keeps newlines and clips the last one', () => {
  const r = parseFrontmatter(fm('description: |\n  line one\n    indented\n  line three\nname: x'));
  assert.equal(r.data.description, 'line one\n  indented\nline three\n');
  assert.equal(r.data.name, 'x');
  assert.equal(r.keyLines.name, 6);
});

test('literal block scalar with keep chomping keeps trailing blank lines', () => {
  const r = parseFrontmatter(fm('description: |+\n  a\n\nname: x'));
  assert.equal(r.data.description, 'a\n\n');
});

test('multi-line plain scalar folds into one line', () => {
  const r = parseFrontmatter(fm('name: x\ndescription: Extract text\n  from PDF files\n  quickly.'));
  assert.equal(r.data.description, 'Extract text from PDF files quickly.');
});

test('unquoted ": " in a value is reported (strict YAML rejects it)', () => {
  const r = parseFrontmatter(fm('name: x\ndescription: Use when: the user asks'));
  assert.equal(r.data.description, 'Use when: the user asks');
  assert.equal(r.errors.length, 1);
  assert.equal(r.errors[0].code, 'yaml-colon');
  assert.equal(r.errors[0].line, 3);
});

test('URLs in plain values are not mistaken for "key: value"', () => {
  const r = parseFrontmatter(fm('name: x\ndescription: See https://example.com/docs for details'));
  assert.equal(r.data.description, 'See https://example.com/docs for details');
  assert.deepEqual(r.errors, []);
});

test('comments are stripped from plain values but kept inside quotes', () => {
  const r = parseFrontmatter(fm('name: x # the name\ndescription: "a # b"\n# full comment line'));
  assert.equal(r.data.name, 'x');
  assert.equal(r.data.description, 'a # b');
  assert.deepEqual(r.errors, []);
});

test('nested metadata map and core-schema typing', () => {
  const r = parseFrontmatter(fm('name: x\nmetadata:\n  author: acme\n  version: "1.0"\n  build: 12\n  beta: true\n  rc: 1.5'));
  assert.deepEqual(r.data.metadata, { author: 'acme', version: '1.0', build: 12, beta: true, rc: 1.5 });
});

test('block sequence at the same indent as its key, and a map inside a list', () => {
  const r = parseFrontmatter(fm('tags:\n- one\n- two\nitems:\n  - k: v\n    z: 2\n  - plain'));
  assert.deepEqual(r.data.tags, ['one', 'two']);
  assert.deepEqual(r.data.items, [{ k: 'v', z: 2 }, 'plain']);
});

test('flow sequence and flow mapping', () => {
  const r = parseFrontmatter(fm('allowed: [Read, "Bash(git:*)", 3]\nmeta: {a: 1, b: "two"}'));
  assert.deepEqual(r.data.allowed, ['Read', 'Bash(git:*)', 3]);
  assert.deepEqual(r.data.meta, { a: 1, b: 'two' });
});

test('empty value is null; key with only nested comment is null', () => {
  const r = parseFrontmatter(fm('name:\ndescription: ~\nlicense: # none'));
  assert.equal(r.data.name, null);
  assert.equal(r.data.description, null);
  assert.equal(r.data.license, null);
});

test('tab indentation is an error', () => {
  const r = parseFrontmatter(fm('metadata:\n\tauthor: x'));
  assert.ok(r.errors.some((e) => e.message.includes('Tabs')));
});

test('duplicate keys produce a warning with the second line', () => {
  const r = parseFrontmatter(fm('name: a\nname: b'));
  assert.equal(r.data.name, 'b');
  assert.equal(r.warnings.length, 1);
  assert.equal(r.warnings[0].code, 'yaml-duplicate-key');
  assert.equal(r.warnings[0].line, 3);
});

test('a line without a colon is an error with its line number', () => {
  const r = parseFrontmatter(fm('name: a\njust some words\ndescription: d'));
  assert.equal(r.errors.length, 1);
  assert.equal(r.errors[0].line, 3);
  assert.equal(r.data.description, 'd');
});

test('missing closing quote is an error', () => {
  const r = parseFrontmatter(fm('name: "abc\ndescription: d'));
  assert.ok(r.errors.some((e) => e.message.includes('closing double quote')));
});

test('multi-line double-quoted value folds line breaks to spaces', () => {
  const r = parseFrontmatter(fm('description: "first\n  second"\nname: x'));
  assert.equal(r.data.description, 'first second');
  assert.equal(r.data.name, 'x');
});

test('a value starting with @ or ` must be quoted', () => {
  const r = parseFrontmatter(fm('name: @me'));
  assert.equal(r.errors.length, 1);
  assert.equal(r.errors[0].line, 2);
});

test('anchors and aliases give a warning, not a crash', () => {
  const r = parseFrontmatter(fm('name: &n x\nother: *n'));
  assert.equal(r.warnings.length, 2);
  assert.equal(r.data.name, '&n x');
});

test('__proto__ keys are ignored', () => {
  const r = parseFrontmatter(fm('__proto__: polluted\nname: x'));
  assert.equal(Object.getPrototypeOf(r.data), Object.prototype);
  assert.equal(r.data.name, 'x');
  assert.equal({}.polluted, undefined);
});

test('closing delimiter "..." is accepted', () => {
  const r = parseFrontmatter('---\nname: a\n...\nbody');
  assert.equal(r.closed, true);
  assert.equal(r.body, 'body');
});

test('resolvePlain follows the YAML 1.2 core schema', () => {
  assert.equal(resolvePlain('yes'), 'yes'); // a string in YAML 1.2
  assert.equal(resolvePlain('0x1F'), 31);
  assert.equal(resolvePlain('-2'), -2);
  assert.equal(resolvePlain('1e3'), 1000);
  assert.equal(resolvePlain('Null'), null);
  assert.equal(resolvePlain('v1.0'), 'v1.0');
});

test('yamlQuote keeps simple text plain and quotes risky text', () => {
  assert.equal(yamlQuote('Extract PDF text.'), 'Extract PDF text.');
  assert.equal(yamlQuote('Use when: asked'), '"Use when: asked"');
  assert.equal(yamlQuote('true'), '"true"');
  assert.equal(yamlQuote('say "hi"'), 'say "hi"');
  assert.equal(yamlQuote('# heading'), '"# heading"');
  assert.equal(yamlQuote('a\\b "c"\n'), '"a\\\\b \\"c\\"\\n"');
});

test('yamlQuote output parses back to the same string', () => {
  for (const s of ['Use when: asked', 'true', '- dash', 'trailing ', "it's", 'a #b', '{x}', '42', 'tab\there']) {
    const r = parseFrontmatter(`---\ndescription: ${yamlQuote(s)}\n---\n`);
    assert.equal(r.data.description, s, `round-trip of ${JSON.stringify(s)}`);
    assert.deepEqual(r.errors, []);
  }
});
