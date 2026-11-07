'use strict';
// Hermetic: the extension reads these to find Claude Code and Codex folders; a developer's own values must not leak in.
delete process.env.CLAUDE_CONFIG_DIR;
delete process.env.CODEX_HOME;
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const root = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

test('manifest: identity, engine, icon and entry point', () => {
  assert.equal(pkg.name, 'skill-shelf');
  assert.ok(pkg.displayName.length > 0 && pkg.displayName.length <= 60);
  assert.equal(pkg.keywords.length, 30);
  assert.equal(pkg.publisher, 'zovo');
  assert.equal(pkg.engines.vscode, '^1.90.0');
  assert.equal(pkg.dependencies, undefined, 'no runtime dependencies');
  assert.equal(fs.existsSync(path.join(root, pkg.main)), true);
  const png = fs.readFileSync(path.join(root, pkg.icon));
  assert.equal(png.toString('ascii', 1, 4), 'PNG');
  assert.equal(png.readUInt32BE(16), 128);
  assert.equal(png.readUInt32BE(20), 128);
});

test('manifest: every menu entry points to a declared command; write commands need trust', () => {
  const declared = new Set(pkg.contributes.commands.map((c) => c.command));
  for (const [menu, entries] of Object.entries(pkg.contributes.menus)) {
    for (const e of entries) assert.ok(declared.has(e.command), `${menu} uses undeclared ${e.command}`);
  }
  for (const id of ['agentSkills.disable', 'agentSkills.enable', 'agentSkills.copyTo', 'agentSkills.create', 'agentSkills.installFromGitHub']) {
    const c = pkg.contributes.commands.find((x) => x.command === id);
    assert.equal(c.enablement, 'isWorkspaceTrusted', `${id} must require trust`);
  }
  assert.equal(pkg.capabilities.untrustedWorkspaces.supported, 'limited');
});

// ---------- minimal vscode stub ----------
function makeVscode(state) {
  class EventEmitter {
    constructor() {
      this.listeners = [];
      this.event = (fn) => {
        this.listeners.push(fn);
        return { dispose() {} };
      };
    }
    fire(v) {
      for (const l of this.listeners) l(v);
    }
  }
  class TreeItem {
    constructor(label, collapsibleState) {
      this.label = label;
      this.collapsibleState = collapsibleState;
    }
  }
  class MarkdownString {
    constructor() {
      this.value = '';
    }
    appendMarkdown(s) {
      this.value += s;
      return this;
    }
    appendText(s) {
      this.value += s;
      return this;
    }
  }
  const noopEvent = () => ({ dispose() {} });
  return {
    EventEmitter,
    TreeItem,
    MarkdownString,
    ThemeIcon: class {
      constructor(id, color) {
        this.id = id;
        this.color = color;
      }
    },
    ThemeColor: class {
      constructor(id) {
        this.id = id;
      }
    },
    Range: class {
      constructor(a, b, c, d) {
        this.start = { line: a, character: b };
        this.end = { line: c, character: d };
      }
    },
    Diagnostic: class {
      constructor(range, message, severity) {
        Object.assign(this, { range, message, severity });
      }
    },
    DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2 },
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    Uri: { file: (p) => ({ scheme: 'file', fsPath: p, toString: () => 'file://' + p }) },
    commands: {
      registerCommand: (id, fn) => {
        state.commands.set(id, fn);
        return { dispose() {} };
      },
      executeCommand: async () => undefined,
    },
    window: {
      createTreeView: () => ({ dispose() {}, description: undefined }),
      onDidChangeWindowState: noopEvent,
      onDidCloseTerminal: noopEvent,
      showWarningMessage: async (...a) => {
        state.messages.push(a[0]);
        return undefined;
      },
      showInformationMessage: async () => undefined,
      showErrorMessage: async (m) => {
        state.messages.push(m);
      },
    },
    languages: {
      createDiagnosticCollection: () => ({
        clear: () => state.diagnostics.clear(),
        set: (uri, list) => state.diagnostics.set(uri.fsPath, list),
        dispose() {},
      }),
    },
    workspace: {
      get workspaceFolders() {
        return state.folders;
      },
      get isTrusted() {
        return state.trusted;
      },
      getConfiguration: () => ({ get: (k, d) => (k in state.config ? state.config[k] : d) }),
      createFileSystemWatcher: () => ({ onDidCreate() {}, onDidChange() {}, onDidDelete() {}, dispose() {} }),
      onDidChangeConfiguration: noopEvent,
      onDidChangeWorkspaceFolders: noopEvent,
      onDidGrantWorkspaceTrust: noopEvent,
      onDidSaveTextDocument: noopEvent,
    },
  };
}

function loadExtension(vscodeStub) {
  const origLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'vscode') return vscodeStub;
    return origLoad.call(this, request, parent, isMain);
  };
  try {
    const p = require.resolve('../src/extension.js');
    delete require.cache[p];
    return require(p);
  } finally {
    Module._load = origLoad;
  }
}

test('activation registers every declared command and builds the tree from a fake HOME', { skip: process.platform === 'win32' }, () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'asm-ext-'));
  const oldHome = process.env.HOME;
  try {
    const home = path.join(tmp, 'home');
    const ws = path.join(tmp, 'proj');
    const put = (rel, text) => {
      fs.mkdirSync(path.dirname(path.join(tmp, rel)), { recursive: true });
      fs.writeFileSync(path.join(tmp, rel), text);
    };
    put('home/.claude/skills/user-skill/SKILL.md', '---\nname: user-skill\ndescription: A user skill.\n---\nBody\n');
    put('proj/.agents/skills/good/SKILL.md', '---\nname: good\ndescription: Good skill.\n---\nBody\n');
    put('proj/.agents/skills/bad/SKILL.md', '---\nname: Bad\n---\nBody\n');
    put('proj/.agents/.disabled-skills/off/SKILL.md', '---\nname: off\ndescription: Off.\n---\nBody\n');
    process.env.HOME = home;

    const state = {
      commands: new Map(),
      diagnostics: new Map(),
      messages: [],
      folders: [{ name: 'proj', uri: { scheme: 'file', fsPath: ws } }],
      trusted: false,
      config: {},
    };
    const ext = loadExtension(makeVscode(state));
    const context = { subscriptions: [] };
    const api = ext.activate(context);

    for (const c of pkg.contributes.commands) assert.ok(state.commands.has(c.command), `missing handler for ${c.command}`);

    api._test.refreshNow();
    const tree = api._test.tree;
    const all = tree.getChildren();
    assert.equal(all[all.length - 1].type, 'support', 'the support row comes last');
    const roots = all.filter((r) => r.type === 'root');
    assert.deepEqual(roots.map((r) => `${r.label}:${r.scope}`), ['proj:project', 'User:user']);

    const projLocs = tree.getChildren(roots[0]);
    assert.deepEqual(projLocs.map((l) => l.result.location.display), ['.agents/skills']);
    const skills = tree.getChildren(projLocs[0]);
    assert.deepEqual(skills.map((s) => s.skill.name), ['Bad', 'good', 'off']); // frontmatter name wins over the folder name

    const badItem = tree.getTreeItem(skills[0]);
    assert.equal(badItem.contextValue, 'skill.enabled');
    assert.equal(badItem.iconPath.id, 'error');
    const offItem = tree.getTreeItem(skills[2]);
    assert.equal(offItem.contextValue, 'skill.disabled');
    assert.match(offItem.description, /^disabled · Off\./);

    const locItem = tree.getTreeItem(projLocs[0]);
    assert.match(locItem.description, /^2 skills, 1 disabled · Codex, Cursor, GitHub Copilot/);

    const userSkills = tree.getChildren(tree.getChildren(roots[1])[0]);
    assert.deepEqual(userSkills.map((s) => s.skill.name), ['user-skill']);

    // diagnostics default to workspace skills only
    const diagFiles = [...state.diagnostics.keys()];
    assert.deepEqual(diagFiles, [path.join(ws, '.agents', 'skills', 'bad', 'SKILL.md')]);

    for (const d of context.subscriptions) if (d && typeof d.dispose === 'function') d.dispose();
  } finally {
    process.env.HOME = oldHome;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('write commands refuse to run in an untrusted workspace', { skip: process.platform === 'win32' }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'asm-ext-'));
  const oldHome = process.env.HOME;
  try {
    fs.mkdirSync(path.join(tmp, 'p', '.claude', 'skills', 'keep'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'p', '.claude', 'skills', 'keep', 'SKILL.md'), '---\nname: keep\ndescription: d\n---\nb\n');
    process.env.HOME = path.join(tmp, 'home');
    const state = {
      commands: new Map(),
      diagnostics: new Map(),
      messages: [],
      folders: [{ name: 'p', uri: { scheme: 'file', fsPath: path.join(tmp, 'p') } }],
      trusted: false,
      config: {},
    };
    const ext = loadExtension(makeVscode(state));
    const context = { subscriptions: [] };
    const api = ext.activate(context);
    api._test.refreshNow();
    const tree = api._test.tree;
    const skillNode = tree.getChildren(tree.getChildren(tree.getChildren()[0])[0])[0];
    for (const id of ['agentSkills.disable', 'agentSkills.copyTo', 'agentSkills.create', 'agentSkills.installFromGitHub']) {
      await state.commands.get(id)(skillNode);
    }
    assert.equal(state.messages.length, 4);
    assert.match(state.messages[0], /read-only in Restricted Mode/);
    assert.equal(fs.existsSync(path.join(tmp, 'p', '.claude', 'skills', 'keep', 'SKILL.md')), true);
    for (const d of context.subscriptions) if (d && typeof d.dispose === 'function') d.dispose();
  } finally {
    process.env.HOME = oldHome;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------- support links (Sponsor, More free viewers) ----------
test('support: package.json has the sponsor field, the two commands, the setting and the welcome line', () => {
  const support = require('../src/support');
  assert.equal(pkg.sponsor.url, 'https://github.com/sponsors/theluckystrike');
  assert.equal(pkg.sponsor.url, support.sponsorUrl());
  const ids = pkg.contributes.commands.map((c) => c.command);
  assert.ok(ids.includes('agentSkills.supportDeveloper') && ids.includes('agentSkills.moreViewers'));
  assert.equal(pkg.contributes.configuration.properties['agentSkills.showSupportLinks'].default, true);
  const welcome = pkg.contributes.viewsWelcome.find((v) => v.contents.includes('command:agentSkills.supportDeveloper'));
  assert.equal(welcome.when, 'config.agentSkills.showSupportLinks');
  assert.ok(support.otherProducts('zovo.skill-shelf').every((p) => p.id !== 'zovo.skill-shelf'));
});

test('support: the tree ends with a Support row by default, agentSkills.showSupportLinks=false hides it', { skip: process.platform === 'win32' }, () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'asm-sup-'));
  const oldHome = process.env.HOME;
  try {
    fs.mkdirSync(path.join(tmp, 'p', '.claude', 'skills', 'keep'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'p', '.claude', 'skills', 'keep', 'SKILL.md'), '---\nname: keep\ndescription: d\n---\nb\n');
    process.env.HOME = path.join(tmp, 'home');
    for (const [config, shown] of [[{}, true], [{ showSupportLinks: false }, false]]) {
      const state = { commands: new Map(), diagnostics: new Map(), messages: [], folders: [{ name: 'p', uri: { scheme: 'file', fsPath: path.join(tmp, 'p') } }], trusted: true, config };
      const ext = loadExtension(makeVscode(state));
      const context = { subscriptions: [] };
      const api = ext.activate(context);
      api._test.refreshNow();
      const tree = api._test.tree;
      const top = tree.getChildren();
      const sup = top.find((n) => n.type === 'support');
      assert.equal(!!sup, shown, JSON.stringify(config));
      if (shown) {
        assert.equal(top[top.length - 1], sup);
        const links = tree.getChildren(sup).map((n) => tree.getTreeItem(n));
        assert.deepEqual(links.map((i) => i.command.command), ['agentSkills.supportDeveloper', 'agentSkills.moreViewers']);
        assert.equal(tree.getTreeItem(sup).collapsibleState, 1, 'collapsed, one line');
      }
      assert.ok(state.commands.has('agentSkills.supportDeveloper') && state.commands.has('agentSkills.moreViewers'));
      for (const d of context.subscriptions) if (d && typeof d.dispose === 'function') d.dispose();
    }
  } finally {
    process.env.HOME = oldHome;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('Claude Code plugin skills show under a read-only "Claude Code plugins" root', { skip: process.platform === 'win32' }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'asm-ext-'));
  const oldHome = process.env.HOME;
  try {
    const home = path.join(tmp, 'home');
    const ws = path.join(tmp, 'proj');
    const put = (rel, text) => {
      fs.mkdirSync(path.dirname(path.join(tmp, rel)), { recursive: true });
      fs.writeFileSync(path.join(tmp, rel), text);
    };
    const inst = path.join(home, '.claude/plugins/cache/acme/doc-tools/2.0.0');
    put('home/.claude/plugins/cache/acme/doc-tools/2.0.0/skills/doc-review/SKILL.md', '---\nname: doc-review\ndescription: Reviews docs.\n---\nBody\n');
    put('home/.claude/plugins/installed_plugins.json', JSON.stringify({ version: 2, plugins: { 'doc-tools@acme': [{ scope: 'user', installPath: inst, version: '2.0.0' }] } }));
    put('home/.claude/settings.json', JSON.stringify({ enabledPlugins: { 'doc-tools@acme': false } }));
    put('proj/.claude/skills/mine/SKILL.md', '---\nname: mine\ndescription: Mine.\n---\nBody\n');
    process.env.HOME = home;
    const state = { commands: new Map(), diagnostics: new Map(), messages: [], folders: [{ name: 'proj', uri: { scheme: 'file', fsPath: ws } }], trusted: true, config: {} };
    const ext = loadExtension(makeVscode(state));
    const context = { subscriptions: [] };
    const api = ext.activate(context);
    api._test.refreshNow();
    const tree = api._test.tree;
    const roots = tree.getChildren().filter((r) => r.type === 'root');
    assert.deepEqual(roots.map((r) => `${r.label}:${r.scope}`), ['proj:project', 'Claude Code plugins:plugin']);
    const pluginLocs = tree.getChildren(roots[1]);
    assert.equal(pluginLocs.length, 1);
    const locItem = tree.getTreeItem(pluginLocs[0]);
    assert.equal(locItem.label, 'doc-tools');
    assert.equal(locItem.contextValue, 'location.plugin');
    assert.match(locItem.description, /^off in settings · 1 skill · acme · 2\.0\.0$/);
    const skills = tree.getChildren(pluginLocs[0]);
    const item = tree.getTreeItem(skills[0]);
    assert.equal(item.contextValue, 'skill.plugin');
    assert.match(item.description, /^\/doc-tools:doc-review · Reviews docs\./);
    assert.deepEqual(tree.getParent(skills[0]), pluginLocs[0]);
    assert.equal(tree.getParent(pluginLocs[0]).scope, 'plugin');
    // Disable never moves a plugin's folder
    await state.commands.get('agentSkills.disable')(skills[0]);
    assert.equal(fs.existsSync(path.join(inst, 'skills/doc-review/SKILL.md')), true);
    // plugin skills are not in the Problems panel by default (diagnostics = workspace)
    assert.equal([...state.diagnostics.keys()].some((k) => k.includes('doc-review')), false);
    // the setting turns the group off
    state.config['showPluginSkills'] = false;
    api._test.refreshNow();
    assert.deepEqual(tree.getChildren().filter((r) => r.type === 'root').map((r) => r.scope), ['project']);
    for (const d of context.subscriptions) if (d && typeof d.dispose === 'function') d.dispose();
  } finally {
    process.env.HOME = oldHome;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
