'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseFrontmatter } = require('../src/core/frontmatter');
const { validateSkill } = require('../src/core/validate');

// Deterministic PRNG (mulberry32) so failures are reproducible.
function rng(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const PIECES = ['name', 'description', ':', ': ', ' ', '  ', '\t', '-', '- ', '"', "'", '\\', '|', '>-', '[', ']', '{', '}', ',', '#', '&a', '*a', '!t', '@', '`', 'x', 'é', '😀', '...', '---', '\n', '\n  ', '\n- ', '\r\n'];

test('parser and validator never throw or hang on 3,000 random frontmatters', () => {
  const r = rng(20261105);
  const started = Date.now();
  for (let i = 0; i < 3000; i++) {
    let yaml = '';
    const n = 1 + Math.floor(r() * 40);
    for (let j = 0; j < n; j++) yaml += PIECES[Math.floor(r() * PIECES.length)];
    const text = `---\n${yaml}\n---\nbody`;
    const fm = parseFrontmatter(text);
    assert.equal(typeof fm.hasFrontmatter, 'boolean');
    for (const e of [...fm.errors, ...fm.warnings]) {
      assert.ok(Number.isInteger(e.line) && e.line >= 1, `bad line in ${JSON.stringify(text)}`);
    }
    const v = validateSkill({ dirName: 'x', skillMdName: 'SKILL.md', text, exists: () => false });
    assert.ok(Array.isArray(v.problems));
  }
  assert.ok(Date.now() - started < 10000, 'fuzz run took too long');
});

test('very long single-line and deeply nested inputs stay bounded', () => {
  const long = parseFrontmatter(`---\nname: x\ndescription: ${'a'.repeat(200000)}\n---\n`);
  assert.equal(long.data.description.length, 200000);
  let nested = '---\n';
  for (let i = 0; i < 60; i++) nested += ' '.repeat(i * 2) + `k${i}:\n`;
  nested += '---\n';
  const deep = parseFrontmatter(nested);
  assert.ok(deep.errors.some((e) => e.message.includes('nested too deeply')));
});
