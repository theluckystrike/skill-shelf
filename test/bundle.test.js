'use strict';
// ZIP reader and writer, and .skill / .zip bundle export and install (src/core/zip.js, src/core/bundle.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { execFileSync } = require('child_process');
const { writeZip, readZip, crc32, ZipError } = require('../src/core/zip');
const { exportSkill, planBundle, installBundle, cleanEntryName, readBundleFile } = require('../src/core/bundle');

const POSIX_ONLY = { skip: process.platform === 'win32' };
const md = (name, desc = 'Does a thing. Use when asked.', body = '# Steps\n') => `---\nname: ${name}\ndescription: ${desc}\n---\n${body}`;

function tmpdir(t) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'asm-bundle-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}
function put(root, rel, text) {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
  return p;
}
const zip = (files) => writeZip(Object.entries(files).map(([name, data]) => ({ name, data: Buffer.from(data) })));

test('crc32 matches the standard check value', () => {
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
  assert.equal(crc32(Buffer.alloc(0)), 0);
});

test('writeZip and readZip round-trip stored and deflated entries, and folders', () => {
  const big = Buffer.from('a'.repeat(5000));
  const rnd = Buffer.from(Array.from({ length: 64 }, (_, i) => (i * 97) & 0xff));
  const buf = writeZip([{ name: 'x/' }, { name: 'x/big.txt', data: big }, { name: 'x/r.bin', data: rnd }, { name: 'x/ünï.md', data: Buffer.from('ok') }]);
  const entries = readZip(buf);
  assert.deepEqual(entries.map((e) => [e.name, e.dir, e.size]), [['x/', true, 0], ['x/big.txt', false, 5000], ['x/r.bin', false, 64], ['x/ünï.md', false, 2]]);
  assert.ok(buf.length < 2000, 'repetitive text is deflated');
  assert.deepEqual(entries[1].read(), big);
  assert.deepEqual(entries[2].read(), rnd);
  assert.equal(entries[3].read().toString(), 'ok');
});

test('readZip refuses damaged, encrypted, oversized and non-ZIP input', () => {
  assert.throws(() => readZip(Buffer.from('not a zip at all, just some text here')), /not a ZIP file/);
  const good = zip({ 'a/SKILL.md': md('a') });
  // flip a data byte: checksum or inflate fails when read
  const bad = Buffer.from(good);
  bad[40] ^= 0xff;
  assert.throws(() => readZip(bad)[0].read(), ZipError);
  // encrypted flag in the central directory
  const enc = Buffer.from(good);
  const cd = enc.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  enc.writeUInt16LE(enc.readUInt16LE(cd + 8) | 1, cd + 8);
  assert.throws(() => readZip(enc), /encrypted/);
  // too many entries, too many bytes
  const many = writeZip(Array.from({ length: 5 }, (_, i) => ({ name: `f${i}`, data: Buffer.from('x') })));
  assert.throws(() => readZip(many, { maxEntries: 4, maxBytes: 1e9 }), /more than 4 entries/);
  assert.throws(() => readZip(many, { maxEntries: 10, maxBytes: 3 }), /unpacks to more than/);
});

test('readZip stops a ZIP bomb at the size its header claims', () => {
  const data = Buffer.alloc(1024 * 1024); // 1 MB of zeros deflates to about 1 KB
  const buf = writeZip([{ name: 'a/SKILL.md', data }]);
  const cd = buf.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  buf.writeUInt32LE(10, cd + 24); // central directory now claims 10 bytes
  const lh = 0;
  buf.writeUInt32LE(10, lh + 22);
  const [e] = readZip(buf);
  assert.equal(e.size, 10);
  assert.throws(() => e.read(), /larger than its header says|checksum/);
});

test('entry names that could leave the target folder are refused', () => {
  for (const bad of ['../evil/SKILL.md', 'a/../../x', '/etc/passwd', 'C:/x/SKILL.md', 'a//b', 'a/./b', 'a\0b']) {
    assert.throws(() => cleanEntryName(bad), ZipError, bad);
  }
  assert.equal(cleanEntryName('./a/SKILL.md'), 'a/SKILL.md');
  assert.equal(cleanEntryName('a\\scripts\\run.py'), 'a/scripts/run.py');
  assert.throws(() => planBundle(zip({ 'ok/SKILL.md': md('ok'), 'ok/../../escape.txt': 'x' })), /leaves its folder/);
});

test('planBundle: Claude layout <name>/SKILL.md with scripts and references', () => {
  const plan = planBundle(
    zip({
      'pdf-tools/SKILL.md': md('pdf-tools', 'Fills PDF forms. Use when the user has a PDF.', 'Run scripts/fill.py. See [ref](references/api.md).\n'),
      'pdf-tools/scripts/fill.py': 'print(1)\n',
      'pdf-tools/references/api.md': '# API\n',
      '__MACOSX/pdf-tools/._SKILL.md': 'junk',
      'pdf-tools/.DS_Store': 'junk',
    })
  );
  assert.equal(plan.skills.length, 1);
  const s = plan.skills[0];
  assert.equal(s.folder, 'pdf-tools');
  assert.equal(s.name, 'pdf-tools');
  assert.match(s.description, /Fills PDF forms/);
  assert.deepEqual(s.files.map((f) => f.rel).sort(), ['SKILL.md', 'references/api.md', 'scripts/fill.py']);
  assert.deepEqual(s.problems.filter((p) => p.severity === 'error'), [], 'referenced files are found inside the bundle');
  assert.deepEqual(plan.skipped, []);
});

test('planBundle: SKILL.md at the top is named after the skill, else after the file', () => {
  assert.equal(planBundle(zip({ 'SKILL.md': md('release-notes'), 'scripts/x.sh': 'echo' }), { bundleName: 'whatever.skill' }).skills[0].folder, 'release-notes');
  const p = planBundle(zip({ 'SKILL.md': md('Bad Name!') }), { bundleName: 'my-skill.skill' });
  assert.equal(p.skills[0].folder, 'my-skill');
  assert.ok(p.skills[0].problems.some((x) => x.severity === 'error'), 'the invalid name is still reported');
  assert.throws(() => planBundle(zip({ 'SKILL.md': md('Bad Name!') }), { bundleName: '.hidden.zip' }), /not a safe folder name/);
});

test('planBundle: several skills, nested SKILL.md stays part of its skill, stray files are listed', () => {
  const plan = planBundle(
    zip({
      'skills/a/SKILL.md': md('a'),
      'skills/a/examples/inner/SKILL.md': md('inner'),
      'skills/b/SKILL.md': md('b'),
      'README.md': '# pack',
    })
  );
  assert.deepEqual(plan.skills.map((s) => s.folder), ['a', 'b']);
  assert.ok(plan.skills[0].files.some((f) => f.rel === 'examples/inner/SKILL.md'));
  assert.deepEqual(plan.skipped, ['README.md (outside a skill folder)']);
  assert.throws(() => planBundle(zip({ 'x/a/SKILL.md': md('a'), 'y/a/SKILL.md': md('a') })), /two skills named "a"/);
});

test('planBundle: secrets, .git and symlinks are left out; missing SKILL.md is explained', () => {
  const plan = planBundle(zip({ 'a/SKILL.md': md('a'), 'a/.env': 'TOKEN=1', 'a/.git/config': 'x', 'a/keys/id_rsa': 'k', 'a/.ssh/known_hosts': 'h' }));
  assert.deepEqual(plan.skills[0].files.map((f) => f.rel), ['SKILL.md']);
  assert.equal(plan.skipped.length, 4);
  assert.ok(plan.skipped.every((s) => /may hold secrets|\.git/.test(s)));

  // a Unix symlink entry (mode 120777 in the external attributes)
  const buf = zip({ 'a/SKILL.md': md('a'), 'a/link': '/etc/passwd' });
  let p = buf.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  p = buf.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]), p + 4);
  buf.writeUInt32LE((0o120777 << 16) >>> 0, p + 38);
  const sp = planBundle(buf);
  assert.deepEqual(sp.skills[0].files.map((f) => f.rel), ['SKILL.md']);
  assert.deepEqual(sp.skipped, ['a/link (symbolic link)']);

  assert.throws(() => planBundle(zip({ 'a/skill.md': md('a') })), /no file named exactly SKILL\.md/);
  assert.throws(() => planBundle(zip({ 'a/README.md': 'x' })), /has no SKILL\.md/);
});

test('installBundle writes every file and never overwrites', POSIX_ONLY, (t) => {
  const d = tmpdir(t);
  const target = path.join(d, 'proj', '.claude', 'skills');
  const plan = planBundle(zip({ 'a/SKILL.md': md('a'), 'a/scripts/run.py': 'print(1)\n', 'b/SKILL.md': md('b') }));
  const done = installBundle(plan.skills, target);
  assert.deepEqual(done.map((x) => path.basename(x.dest)), ['a', 'b']);
  assert.equal(fs.readFileSync(path.join(target, 'a', 'scripts', 'run.py'), 'utf8'), 'print(1)\n');
  assert.deepEqual(fs.readdirSync(target).sort(), ['a', 'b'], 'no temporary folders left');

  // b exists now: a second install of a fresh "c" plus "b" writes nothing at all
  const plan2 = planBundle(zip({ 'b/SKILL.md': md('b', 'Changed.'), 'c/SKILL.md': md('c') }));
  assert.throws(() => installBundle(plan2.skills, target), /"b" already exists.*Nothing was installed/);
  assert.equal(fs.existsSync(path.join(target, 'c')), false);
  assert.match(fs.readFileSync(path.join(target, 'b', 'SKILL.md'), 'utf8'), /Does a thing/);
});

test('exportSkill writes <folder>/… with the same safety rules as Copy, and installs back', POSIX_ONLY, (t) => {
  const d = tmpdir(t);
  const src = path.join(d, 'home', '.claude', 'skills', 'pdf-tools');
  put(src, 'SKILL.md', md('pdf-tools', 'Fills PDFs. Use when asked.', 'Run scripts/fill.py.\n'));
  put(src, 'scripts/fill.py', 'print(1)\n');
  put(src, '.env', 'SECRET=1');
  put(src, '.git/HEAD', 'ref');
  put(d, 'outside.txt', 'not part of the skill');
  fs.symlinkSync(path.join(d, 'outside.txt'), path.join(src, 'leak.txt'));
  const res = exportSkill(src);
  assert.equal(res.folder, 'pdf-tools');
  assert.equal(res.files, 2);
  assert.ok(res.skipped.some((s) => /\.env/.test(s)));
  assert.ok(res.skipped.some((s) => /leak\.txt/.test(s)));
  assert.deepEqual(readZip(res.buffer).map((e) => e.name).sort(), ['pdf-tools/SKILL.md', 'pdf-tools/scripts/fill.py']);

  const file = path.join(d, 'pdf-tools.skill');
  fs.writeFileSync(file, res.buffer);
  try {
    // Info-ZIP's own test of the archive, when unzip is installed
    const out = execFileSync('unzip', ['-t', file], { encoding: 'utf8' });
    assert.match(out, /No errors detected/);
  } catch (e) {
    if (e instanceof assert.AssertionError || e.status) throw e;
  }
  const plan = planBundle(readBundleFile(file), { bundleName: 'pdf-tools.skill' });
  const target = path.join(d, 'proj', '.agents', 'skills');
  installBundle(plan.skills, target);
  assert.equal(fs.readFileSync(path.join(target, 'pdf-tools', 'scripts', 'fill.py'), 'utf8'), 'print(1)\n');
  assert.throws(() => exportSkill(path.join(d, 'nope')), /does not exist/);
  fs.mkdirSync(path.join(d, 'empty'));
  assert.throws(() => exportSkill(path.join(d, 'empty')), /has no SKILL\.md/);
});

test('bundles from other tools: Info-ZIP zip and Python zipfile', POSIX_ONLY, (t) => {
  const d = tmpdir(t);
  put(d, 'src/lint-fix/SKILL.md', md('lint-fix'));
  put(d, 'src/lint-fix/scripts/fix.sh', 'echo fix\n'.repeat(50));
  let made = 0;
  try {
    execFileSync('zip', ['-qr', path.join(d, 'a.skill'), 'lint-fix'], { cwd: path.join(d, 'src'), stdio: 'ignore' });
    const p = planBundle(fs.readFileSync(path.join(d, 'a.skill')));
    assert.deepEqual(p.skills[0].files.map((f) => f.rel).sort(), ['SKILL.md', 'scripts/fix.sh']);
    assert.equal(p.skills[0].files.find((f) => f.rel === 'scripts/fix.sh').read().toString(), 'echo fix\n'.repeat(50));
    made++;
  } catch (e) {
    if (e instanceof assert.AssertionError) throw e;
  }
  try {
    const py = 'import zipfile,sys,os\nz=zipfile.ZipFile(sys.argv[1],"w",zipfile.ZIP_DEFLATED)\nfor r,_,fs in os.walk("lint-fix"):\n  [z.write(os.path.join(r,f)) for f in fs]\nz.close()\n';
    execFileSync('python3', ['-c', py, path.join(d, 'b.skill')], { cwd: path.join(d, 'src'), stdio: 'ignore' });
    const p = planBundle(fs.readFileSync(path.join(d, 'b.skill')));
    assert.equal(p.skills[0].folder, 'lint-fix');
    assert.equal(p.skills[0].files.length, 2);
    made++;
  } catch (e) {
    if (e instanceof assert.AssertionError) throw e;
  }
  if (made === 0) t.skip('neither zip nor python3 is installed');
  // and our own output opens with zlib's raw inflate the way other unzip tools read it
  const own = writeZip([{ name: 'x/SKILL.md', data: Buffer.from(md('x').repeat(20)) }]);
  const n = own.readUInt16LE(26);
  const body = own.subarray(30 + n, 30 + n + own.readUInt32LE(18));
  assert.equal(zlib.inflateRawSync(body).toString(), md('x').repeat(20));
});
