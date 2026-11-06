'use strict';
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
    const roots = tree.getChildren();
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
