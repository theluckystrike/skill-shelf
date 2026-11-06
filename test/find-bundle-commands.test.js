'use strict';
// Find Skill, Preview SKILL.md, Export Skill as .skill File and Install Skill from .skill or .zip File,
// run through the extension with a stub vscode module, a temp HOME and a temp workspace.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const { writeZip, readZip } = require('../src/core/zip');

const POSIX_ONLY = { skip: process.platform === 'win32' };
const pkg = require('../package.json');
const md = (name, desc = 'Does a thing. Use when asked.') => `---\nname: ${name}\ndescription: ${desc}\n---\n# ${name}\n\nSteps.\n`;

function makeVscode(state) {
  class EventEmitter {
    constructor() {
      this.event = () => ({ dispose() {} });
    }
    fire() {}
  }
  const noopEvent = () => ({ dispose() {} });
  const next = (kind, ...args) => {
    state.calls.push([kind, ...args]);
    const fn = state.ui[kind];
    return typeof fn === 'function' ? fn(...args) : undefined;
  };
  return {
    EventEmitter,
    MarkdownString: class {
      constructor() {
        this.value = '';
      }
      appendMarkdown(s) {
        this.value += s;
      }
      appendText(s) {
        this.value += s;
      }
    },
    TreeItem: class {
      constructor(label, collapsibleState) {
        this.label = label;
        this.collapsibleState = collapsibleState;
      }
    },
    ThemeIcon: class {
      constructor(id) {
        this.id = id;
      }
    },
    ThemeColor: class {},
    Range: class {},
    Diagnostic: class {},
    DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2 },
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    Uri: { file: (p) => ({ scheme: 'file', fsPath: p }) },
    commands: {
      registerCommand: (id, fn) => {
        state.commands.set(id, fn);
        return { dispose() {} };
      },
      executeCommand: async (id, ...a) => {
        state.calls.push(['executeCommand', id, ...a]);
        if (state.commands.has(id)) return state.commands.get(id)(...a);
      },
    },
    env: { clipboard: { writeText: async () => {} } },
    window: {
      createTreeView: () => ({
        dispose() {},
        reveal: async (node, opts) => {
          state.revealed.push({ node, opts });
        },
      }),
      createQuickPick: () => {
        const handlers = {};
        const qp = {
          items: [],
          selectedItems: [],
          activeItems: [],
          onDidAccept: (fn) => (handlers.accept = fn),
          onDidHide: (fn) => (handlers.hide = fn),
          onDidTriggerItemButton: (fn) => (handlers.button = fn),
          show() {
            state.quickPicks.push(qp);
            Promise.resolve().then(() => state.ui.findPick(qp, handlers));
          },
          hide() {
            if (handlers.hide) handlers.hide();
          },
          dispose() {
            qp.disposed = true;
          },
        };
        return qp;
      },
      onDidChangeWindowState: noopEvent,
      onDidCloseTerminal: noopEvent,
      showWarningMessage: async (...a) => next('warning', ...a),
      showInformationMessage: async (...a) => next('info', ...a),
      showErrorMessage: async (...a) => next('error', ...a),
      showQuickPick: async (items, opts) => next('quickPick', await items, opts),
      showSaveDialog: async (opts) => next('saveDialog', opts),
      showOpenDialog: async (opts) => next('openDialog', opts),
      showTextDocument: async (uri) => {
        state.opened.push(uri.fsPath);
      },
    },
    languages: { createDiagnosticCollection: () => ({ clear() {}, set() {}, dispose() {} }) },
    workspace: {
      get workspaceFolders() {
        return state.folders;
      },
      get isTrusted() {
        return state.trusted;
      },
      getConfiguration: () => ({ get: (k, d) => d }),
      createFileSystemWatcher: () => ({ onDidCreate() {}, onDidChange() {}, onDidDelete() {}, dispose() {} }),
      onDidChangeConfiguration: noopEvent,
      onDidChangeWorkspaceFolders: noopEvent,
      onDidGrantWorkspaceTrust: noopEvent,
      onDidSaveTextDocument: noopEvent,
    },
  };
}

function setup(t, { trusted = true } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'asm-find-'));
  const oldHome = process.env.HOME;
  t.after(() => {
    process.env.HOME = oldHome;
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  const put = (rel, text) => {
    const p = path.join(tmp, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, text);
    return p;
  };
  put('home/.claude/skills/pdf-tools/SKILL.md', md('pdf-tools', 'Fills PDF forms. Use when the user has a PDF.'));
  put('home/.claude/skills/pdf-tools/scripts/fill.py', 'print(1)\n');
  put('proj/.claude/skills/release-notes/SKILL.md', md('release-notes', 'Writes release notes from merged PRs.'));
  put('proj/.agents/skills/lint-fix/SKILL.md', md('lint-fix', 'Fixes lint errors. $(alert) icons stay text.'));
  put('proj/.cursor/skills/Broken_Skill/SKILL.md', '---\nname: Broken_Skill\n---\nbody\n');
  process.env.HOME = path.join(tmp, 'home');
  const ws = path.join(tmp, 'proj');
  const state = {
    commands: new Map(),
    calls: [],
    opened: [],
    revealed: [],
    quickPicks: [],
    ui: {},
    folders: [{ name: 'proj', uri: { scheme: 'file', fsPath: ws } }],
    trusted,
  };
  const orig = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'vscode') return makeVscode(state);
    return orig.call(this, request, parent, isMain);
  };
  let ext;
  try {
    const p = require.resolve('../src/extension.js');
    delete require.cache[p];
    ext = require(p);
  } finally {
    Module._load = orig;
  }
  const context = { subscriptions: [] };
  const api = ext.activate(context);
  t.after(() => {
    for (const d of context.subscriptions) if (d && typeof d.dispose === 'function') d.dispose();
  });
  api._test.refreshNow();
  const run = (id, ...args) => state.commands.get(id)(...args);
  const skillNode = (name) => {
    for (const r of api._test.results()) {
      const s = r.skills.find((x) => x.name === name);
      if (s) return { type: 'skill', skill: s, location: r.location };
    }
    throw new Error(`no skill ${name}`);
  };
  const locationNode = (scope, display) => ({ type: 'location', result: api._test.results().find((r) => r.location.scope === scope && r.location.display === display) });
  return { tmp, ws, home: process.env.HOME, put, state, api, run, skillNode, locationNode };
}

test('manifest: the four new commands, their menus, trust and the Explorer entry for .skill and .zip', () => {
  const byId = Object.fromEntries(pkg.contributes.commands.map((c) => [c.command, c]));
  for (const id of ['agentSkills.find', 'agentSkills.preview', 'agentSkills.exportBundle', 'agentSkills.installBundle']) assert.ok(byId[id], id);
  assert.equal(byId['agentSkills.exportBundle'].enablement, 'isWorkspaceTrusted');
  assert.equal(byId['agentSkills.installBundle'].enablement, 'isWorkspaceTrusted');
  assert.equal(byId['agentSkills.find'].enablement, undefined, 'Find works in Restricted Mode');
  assert.ok(pkg.contributes.menus['view/title'].some((m) => m.command === 'agentSkills.find' && /^navigation/.test(m.group)));
  const ex = pkg.contributes.menus['explorer/context'].find((m) => m.command === 'agentSkills.installBundle');
  assert.match(ex.when, /isWorkspaceTrusted/);
  const re = new RegExp(ex.when.match(/=~ \/(.+)\/i/)[1], 'i');
  assert.ok(re.test('.skill') && re.test('.ZIP') && !re.test('.md'));
  assert.ok(pkg.contributes.viewsWelcome[0].contents.includes('command:agentSkills.installBundle'));
});

test('find: lists every skill with folder, agents and problems; Enter opens SKILL.md', POSIX_ONLY, async (t) => {
  const { run, state, ws } = setup(t);
  state.ui.findPick = (qp, h) => {
    assert.equal(qp.matchOnDescription, true);
    assert.equal(qp.matchOnDetail, true);
    assert.match(qp.placeholder, /Search 4 skills/);
    qp.selectedItems = [qp.items.find((i) => i.label.endsWith('release-notes'))];
    h.accept();
  };
  await run('agentSkills.find');
  const qp = state.quickPicks[0];
  const labels = qp.items.map((i) => i.label).sort();
  assert.deepEqual(labels, ['$(book) lint-fix', '$(book) pdf-tools', '$(book) release-notes', '$(error) Broken_Skill']);
  const broken = qp.items.find((i) => i.label.includes('Broken_Skill'));
  assert.match(broken.description, /^proj · \.cursor\/skills · \d+ errors?/);
  const pdf = qp.items.find((i) => i.label.includes('pdf-tools'));
  assert.match(pdf.description, /^User · ~\/\.claude\/skills/);
  assert.match(pdf.detail, /Fills PDF forms.*· Claude Code/);
  const lint = qp.items.find((i) => i.label.includes('lint-fix'));
  assert.ok(!lint.detail.includes('$(alert)'), 'icon syntax from a description is broken up');
  assert.equal(state.opened.at(-1), path.join(ws, '.claude', 'skills', 'release-notes', 'SKILL.md'));
  assert.equal(qp.disposed, true);
});

test('find: the item buttons preview SKILL.md and reveal the skill in the view', POSIX_ONLY, async (t) => {
  const { run, state, home, api } = setup(t);
  state.ui.findPick = (qp, h) => {
    const item = qp.items.find((i) => i.label.endsWith('pdf-tools'));
    h.button({ item, button: item.buttons[0] });
  };
  await run('agentSkills.find');
  const prev = state.calls.find((c) => c[0] === 'executeCommand' && c[1] === 'markdown.showPreview');
  assert.equal(prev[2].fsPath, path.join(home, '.claude', 'skills', 'pdf-tools', 'SKILL.md'));

  state.ui.findPick = (qp, h) => {
    const item = qp.items.find((i) => i.label.endsWith('lint-fix'));
    h.button({ item, button: item.buttons[1] });
  };
  await run('agentSkills.find');
  assert.ok(state.calls.some((c) => c[0] === 'executeCommand' && c[1] === 'agentSkills.tree.focus'));
  const { node, opts } = state.revealed.at(-1);
  assert.equal(node.skill.name, 'lint-fix');
  assert.deepEqual(opts, { select: true, focus: true, expand: false });
  // getParent walks skill -> location -> project root, so reveal can find the item
  const tree = api._test.tree;
  const loc = tree.getParent(node);
  assert.equal(loc.type, 'location');
  assert.equal(loc.result.location.display, '.agents/skills');
  const root = tree.getParent(loc);
  assert.equal(root.type, 'root');
  assert.equal(root.label, 'proj');
  assert.equal(tree.getParent(root), undefined);
  const userLoc = tree.getParent({ type: 'skill', skill: node.skill, location: api._test.results().find((r) => r.location.display === '~/.claude/skills').location });
  assert.equal(tree.getParent(userLoc).id, 'user');
});

test('find with no skills says so; preview from the palette picks a skill', POSIX_ONLY, async (t) => {
  const { run, state, tmp, api } = setup(t);
  state.ui.quickPick = (items) => items.find((i) => i.label === 'release-notes');
  await run('agentSkills.preview');
  assert.match(state.calls.at(-1)[2].fsPath, /release-notes\/SKILL\.md$/);
  fs.rmSync(path.join(tmp, 'proj'), { recursive: true, force: true });
  fs.rmSync(path.join(tmp, 'home'), { recursive: true, force: true });
  api._test.refreshNow();
  await run('agentSkills.find');
  assert.equal(state.quickPicks.length, 0);
  assert.match(state.calls.at(-1)[1], /No agent skills found/);
});

test('export: writes <name>/… to the chosen .skill file, leaves out secrets, refuses a path inside the skill', POSIX_ONLY, async (t) => {
  const { run, state, put, tmp, skillNode } = setup(t);
  put('home/.claude/skills/pdf-tools/.env', 'TOKEN=1');
  const out = path.join(tmp, 'out', 'pdf-tools.skill');
  fs.mkdirSync(path.dirname(out));
  state.ui.saveDialog = (opts) => {
    assert.equal(path.basename(opts.defaultUri.fsPath), 'pdf-tools.skill');
    assert.deepEqual(Object.values(opts.filters), [['skill'], ['zip']]);
    return { scheme: 'file', fsPath: out };
  };
  state.ui.info = () => 'Reveal in File Explorer';
  await run('agentSkills.exportBundle', skillNode('pdf-tools'));
  assert.deepEqual(readZip(fs.readFileSync(out)).map((e) => e.name).sort(), ['pdf-tools/SKILL.md', 'pdf-tools/scripts/fill.py']);
  const msg = state.calls.find((c) => c[0] === 'info')[1];
  assert.match(msg, /Exported "pdf-tools" to pdf-tools\.skill \(2 files, .*\)\. Left out: \.env \(may hold secrets\)\./);
  assert.equal(state.calls.at(-1)[1], 'revealFileInOS');

  const inside = path.join(tmp, 'home', '.claude', 'skills', 'pdf-tools', 'self.skill');
  state.ui.saveDialog = () => ({ scheme: 'file', fsPath: inside });
  await run('agentSkills.exportBundle', skillNode('pdf-tools'));
  assert.match(state.calls.at(-1)[1], /outside the skill folder/);
  assert.equal(fs.existsSync(inside), false);

  state.ui.saveDialog = () => ({ scheme: 'file', fsPath: path.join(tmp, 'out', 'b.skill') });
  await run('agentSkills.exportBundle', skillNode('Broken_Skill'));
  assert.match(state.calls.filter((c) => c[0] === 'info').at(-1)[1], /has errors, so agents may skip it/);
});

test('install from the Explorer: one skill, confirm shows target and file count, then it is listed', POSIX_ONLY, async (t) => {
  const { run, state, tmp, ws, skillNode } = setup(t);
  const file = path.join(tmp, 'Downloads', 'csv-clean.skill');
  fs.mkdirSync(path.dirname(file));
  fs.writeFileSync(file, writeZip([{ name: 'csv-clean/SKILL.md', data: Buffer.from(md('csv-clean')) }, { name: 'csv-clean/scripts/clean.py', data: Buffer.from('x=1\n') }]));
  state.ui.quickPick = (items, opts) => {
    assert.match(opts.placeHolder, /Install "csv-clean" into/);
    assert.equal(opts.ignoreFocusOut, true, 'a closing context menu cannot dismiss the folder picker');
    return items.find((i) => i.label === '.agents/skills' && /Project/.test(i.description));
  };
  // cancel first: nothing is written
  state.ui.warning = () => undefined;
  await run('agentSkills.installBundle', { scheme: 'file', fsPath: file });
  assert.equal(fs.existsSync(path.join(ws, '.agents', 'skills', 'csv-clean')), false);

  state.ui.warning = (msg, opts) => {
    assert.equal(msg, 'Install "csv-clean" from csv-clean.skill?');
    assert.match(opts.detail, /csv-clean: 2 files/);
    assert.match(opts.detail, new RegExp(`Into: ${path.join(ws, '.agents', 'skills').replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}`));
    assert.match(opts.detail, /Nothing that exists is overwritten/);
    return 'Install';
  };
  state.ui.info = () => 'Open SKILL.md';
  await run('agentSkills.installBundle', { scheme: 'file', fsPath: file });
  assert.equal(fs.readFileSync(path.join(ws, '.agents', 'skills', 'csv-clean', 'scripts', 'clean.py'), 'utf8'), 'x=1\n');
  assert.equal(skillNode('csv-clean').location.display, '.agents/skills', 'the tree was refreshed');
  assert.equal(state.opened.at(-1), path.join(ws, '.agents', 'skills', 'csv-clean', 'SKILL.md'));

  // again: refused, nothing changes
  await run('agentSkills.installBundle', { scheme: 'file', fsPath: file });
  assert.match(state.calls.filter((c) => c[0] === 'error').at(-1)[1], /already exists.*Nothing was installed/);
});

test('install from the palette: open dialog, a bundle with two skills, a location node as target', POSIX_ONLY, async (t) => {
  const { run, state, tmp, home, locationNode } = setup(t);
  const file = path.join(tmp, 'pack.zip');
  fs.writeFileSync(file, writeZip([{ name: 'a/SKILL.md', data: Buffer.from(md('a')) }, { name: 'b/SKILL.md', data: Buffer.from(md('b')) }, { name: 'a/.env', data: Buffer.from('K=1') }]));
  state.ui.openDialog = (opts) => {
    assert.deepEqual(opts.filters, { 'Skill bundle': ['skill', 'zip'] });
    return [{ scheme: 'file', fsPath: file }];
  };
  state.ui.quickPick = (items, opts) => {
    assert.equal(opts.canPickMany, true);
    assert.equal(items.length, 2);
    assert.ok(items.every((i) => i.picked));
    return [items[1]];
  };
  state.ui.warning = (msg, opts) => {
    assert.equal(msg, 'Install "b" from pack.zip?');
    assert.match(opts.detail, /Left out: a\/\.env \(may hold secrets\)/);
    return 'Install';
  };
  await run('agentSkills.installBundle', locationNode('user', '~/.cursor/skills'));
  assert.equal(fs.existsSync(path.join(home, '.cursor', 'skills', 'b', 'SKILL.md')), true);
  assert.equal(fs.existsSync(path.join(home, '.cursor', 'skills', 'a')), false);
  assert.equal(state.calls.filter((c) => c[0] === 'quickPick').length, 1, 'no folder picker when started from a folder');
});

test('install: a damaged or unsafe bundle shows a clear error and writes nothing', POSIX_ONLY, async (t) => {
  const { run, state, tmp, ws } = setup(t);
  const junk = path.join(tmp, 'junk.skill');
  fs.writeFileSync(junk, 'this is not a zip file at all');
  await run('agentSkills.installBundle', { scheme: 'file', fsPath: junk });
  assert.match(state.calls.at(-1)[1], /Could not read junk\.skill: This is not a ZIP file/);
  const evil = path.join(tmp, 'evil.zip');
  fs.writeFileSync(evil, writeZip([{ name: 'x/SKILL.md', data: Buffer.from(md('x')) }, { name: '../../.bashrc', data: Buffer.from('rm -rf ~') }]));
  await run('agentSkills.installBundle', { scheme: 'file', fsPath: evil });
  assert.match(state.calls.at(-1)[1], /leaves its folder/);
  assert.equal(fs.existsSync(path.join(tmp, '.bashrc')), false);
  assert.equal(fs.existsSync(path.join(ws, '.claude', 'skills', 'x')), false);
});

test('export and install refuse to run in Restricted Mode; find and preview still work', POSIX_ONLY, async (t) => {
  const { run, state, skillNode, tmp } = setup(t, { trusted: false });
  state.ui.saveDialog = () => ({ scheme: 'file', fsPath: path.join(tmp, 'x.skill') });
  await run('agentSkills.exportBundle', skillNode('pdf-tools'));
  await run('agentSkills.installBundle', { scheme: 'file', fsPath: path.join(tmp, 'x.skill') });
  const warnings = state.calls.filter((c) => c[0] === 'warning').map((c) => c[1]);
  assert.equal(warnings.length, 2);
  assert.ok(warnings.every((w) => /read-only in Restricted Mode/.test(w)));
  assert.equal(fs.existsSync(path.join(tmp, 'x.skill')), false);
  await run('agentSkills.preview', skillNode('pdf-tools'));
  assert.equal(state.calls.at(-1)[1], 'markdown.showPreview');
});

test('find rescans a stale list but redraws the tree only when something changed', POSIX_ONLY, async (t) => {
  const { run, state, api, put } = setup(t);
  let fired = 0;
  const orig = api._test.tree.fire.bind(api._test.tree);
  api._test.tree.fire = () => {
    fired++;
    orig();
  };
  const realNow = Date.now;
  let offset = 0;
  Date.now = () => realNow() + offset;
  t.after(() => {
    Date.now = realNow;
  });
  state.ui.findPick = (qp, h) => qp.hide();
  offset = 5000;
  await run('agentSkills.find');
  assert.equal(fired, 0, 'nothing changed: no redraw while the search box opens');
  put('proj/.claude/skills/new-skill/SKILL.md', md('new-skill'));
  offset = 10000;
  await run('agentSkills.find');
  assert.equal(fired, 1, 'a new skill: one redraw');
  assert.ok(state.quickPicks.at(-1).items.some((i) => i.label.endsWith('new-skill')));
});

test('background refreshes redraw only on change; settings changes always redraw', POSIX_ONLY, async (t) => {
  const { state, api, put } = setup(t);
  let fired = 0;
  const orig = api._test.tree.fire.bind(api._test.tree);
  api._test.tree.fire = () => {
    fired++;
    orig();
  };
  api._test.refreshNow(false);
  assert.equal(fired, 0, 'same skills, same problems: no redraw');
  put('proj/.claude/skills/release-notes/SKILL.md', '---\nname: release-notes\n---\nno description now\n');
  api._test.refreshNow(false);
  assert.equal(fired, 1, 'a new problem in a SKILL.md: redraw');
  api._test.refreshNow(true);
  assert.equal(fired, 2, 'the Refresh command always redraws');
  await state.commands.get('agentSkills.refresh')();
  assert.equal(fired, 3);
});
