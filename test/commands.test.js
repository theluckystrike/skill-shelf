'use strict';
// Every command path, run against a temp HOME and a temp workspace that use the
// Claude Code (.claude/skills), Codex (.agents/skills, ~/.codex/skills) and Cursor
// (.cursor/skills, ~/.cursor/skills) layouts. The vscode module is a stub that records
// what the extension asks the UI to do and answers from a script.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const { validateSkill } = require('../src/core/validate');

const POSIX_ONLY = { skip: process.platform === 'win32' };

// VS Code's MarkdownString.appendText escaping (src/vs/base/common/htmlContent.ts).
const escapeMd = (t) => t.replace(/[\\`*_{}[\]()#+\-!~]/g, '\\$&');

function makeVscode(state) {
  class EventEmitter {
    constructor() {
      this.event = () => ({ dispose() {} });
    }
    fire() {}
  }
  class MarkdownString {
    constructor(value = '', supportThemeIcons = false) {
      this.value = value;
      this.supportThemeIcons = supportThemeIcons;
      this.markdownCalls = [];
    }
    appendMarkdown(s) {
      this.markdownCalls.push(s);
      this.value += s;
      return this;
    }
    appendText(s) {
      this.value += escapeMd(s).replace(/\n/g, '\n\n');
      return this;
    }
  }
  const noopEvent = () => ({ dispose() {} });
  const next = (kind, ...args) => {
    const fn = state.ui[kind];
    state.calls.push([kind, ...args]);
    return typeof fn === 'function' ? fn(...args) : undefined;
  };
  return {
    EventEmitter,
    MarkdownString,
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
    Uri: { file: (p) => ({ scheme: 'file', fsPath: p }) },
    commands: {
      registerCommand: (id, fn) => {
        state.commands.set(id, fn);
        return { dispose() {} };
      },
      executeCommand: async (...a) => {
        state.calls.push(['executeCommand', ...a]);
      },
    },
    env: {
      clipboard: {
        writeText: async (t) => {
          state.clipboard = t;
        },
      },
    },
    window: {
      createTreeView: () => ({ dispose() {} }),
      onDidChangeWindowState: noopEvent,
      onDidCloseTerminal: noopEvent,
      showWarningMessage: async (...a) => next('warning', ...a),
      showInformationMessage: async (...a) => next('info', ...a),
      showErrorMessage: async (...a) => next('error', ...a),
      showQuickPick: async (items, opts) => next('quickPick', await items, opts),
      showInputBox: async (opts) => next('inputBox', opts),
      showWorkspaceFolderPick: async (opts) => next('folderPick', opts),
      showTextDocument: async (uri, opts) => {
        state.opened.push({ file: uri.fsPath, opts });
      },
      createTerminal: (opts) => {
        const t = {
          opts,
          sent: [],
          shown: false,
          show() {
            this.shown = true;
          },
          sendText(text, addNewLine) {
            this.sent.push([text, addNewLine]);
          },
          dispose() {},
        };
        state.terminals.push(t);
        return t;
      },
    },
    languages: {
      createDiagnosticCollection: () => ({ clear() {}, set() {}, dispose() {} }),
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

function loadExtension(stub) {
  const orig = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'vscode') return stub;
    return orig.call(this, request, parent, isMain);
  };
  try {
    const p = require.resolve('../src/extension.js');
    delete require.cache[p];
    return require(p);
  } finally {
    Module._load = orig;
  }
}

const md = (name, desc = 'Does a thing. Use when asked.') => `---\nname: ${name}\ndescription: ${desc}\n---\n# ${name}\n\nSteps.\n`;

/** Build the fixture tree, activate the extension, return helpers. */
function setup(t) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'asm-cmd-'));
  const oldHome = process.env.HOME;
  const oldPath = process.env.PATH;
  t.after(() => {
    process.env.HOME = oldHome;
    process.env.PATH = oldPath;
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  const home = path.join(tmp, 'home');
  const ws = path.join(tmp, 'proj');
  const put = (rel, text) => {
    const p = path.join(tmp, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, text);
    return p;
  };
  // Claude Code
  put('home/.claude/skills/pdf-tools/SKILL.md', md('pdf-tools'));
  put('home/.claude/skills/pdf-tools/scripts/run.py', 'print(1)\n');
  put('proj/.claude/skills/release-notes/SKILL.md', md('release-notes'));
  // Codex
  put('proj/.agents/skills/lint-fix/SKILL.md', md('lint-fix'));
  put('home/.agents/skills/sql-review/SKILL.md', md('sql-review'));
  put('home/.codex/skills/legacy-skill/SKILL.md', md('legacy-skill'));
  // Cursor
  put('proj/.cursor/skills/ui-review/SKILL.md', md('ui-review'));
  put('home/.cursor/skills/commit-msg/SKILL.md', md('commit-msg'));
  fs.mkdirSync(path.join(ws, '.cursor', 'skills', 'no-md'), { recursive: true });
  process.env.HOME = home;

  const state = {
    commands: new Map(),
    calls: [],
    opened: [],
    terminals: [],
    clipboard: null,
    ui: {},
    folders: [{ name: 'proj', uri: { scheme: 'file', fsPath: ws } }],
    trusted: true,
    config: {},
  };
  const ext = loadExtension(makeVscode(state));
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
  const locationNode = (scope, display) => {
    const result = api._test.results().find((r) => r.location.scope === scope && r.location.display === display);
    return { type: 'location', result };
  };
  return { tmp, home, ws, put, state, api, run, skillNode, locationNode };
}

test('refresh finds Claude Code, Codex and Cursor skills in both scopes', POSIX_ONLY, (t) => {
  const { api } = setup(t);
  const found = api._test
    .results()
    .filter((r) => r.skills.length)
    .map((r) => `${r.location.scope} ${r.location.display}: ${r.skills.map((s) => s.name).join(',')}`)
    .sort();
  assert.deepEqual(found, [
    'project .agents/skills: lint-fix',
    'project .claude/skills: release-notes',
    'project .cursor/skills: no-md,ui-review',
    'user ~/.agents/skills: sql-review',
    'user ~/.claude/skills: pdf-tools',
    'user ~/.codex/skills: legacy-skill',
    'user ~/.cursor/skills: commit-msg',
  ]);
});

test('open: from a tree node, from the picker, and a folder without SKILL.md', POSIX_ONLY, async (t) => {
  const { run, skillNode, state, home, ws } = setup(t);
  await run('agentSkills.open', skillNode('pdf-tools'));
  assert.equal(state.opened.at(-1).file, path.join(home, '.claude', 'skills', 'pdf-tools', 'SKILL.md'));

  state.ui.quickPick = (items) => items.find((i) => i.label === 'ui-review');
  await run('agentSkills.open');
  assert.equal(state.opened.at(-1).file, path.join(ws, '.cursor', 'skills', 'ui-review', 'SKILL.md'));

  const before = state.opened.length;
  await run('agentSkills.open', skillNode('no-md'));
  assert.equal(state.opened.length, before);
  assert.match(state.calls.at(-1)[1], /has no SKILL\.md/);
});

test('openAtLine opens known SKILL.md files only', POSIX_ONLY, async (t) => {
  const { run, state, ws, put } = setup(t);
  const file = path.join(ws, '.agents', 'skills', 'lint-fix', 'SKILL.md');
  await run('agentSkills.openAtLine', file, 3);
  assert.equal(state.opened.length, 1);
  assert.deepEqual(state.opened[0].opts.selection.start, { line: 2, character: 0 });
  const other = put('home/.ssh/id_rsa', 'PRIVATE');
  await run('agentSkills.openAtLine', other, 1);
  await run('agentSkills.openAtLine', '/etc/hosts', 1);
  assert.equal(state.opened.length, 1, 'files the scan did not find are not opened');
});

test('reveal: a skill folder, and a location that does not exist yet', POSIX_ONLY, async (t) => {
  const { run, skillNode, locationNode, state, home } = setup(t);
  await run('agentSkills.reveal', skillNode('commit-msg'));
  const last = state.calls.at(-1);
  assert.equal(last[0], 'executeCommand');
  assert.equal(last[1], 'revealFileInOS');
  assert.equal(last[2].fsPath, path.join(home, '.cursor', 'skills', 'commit-msg'));
  await run('agentSkills.reveal', locationNode('user', '~/.gemini/skills'));
  assert.match(state.calls.at(-1)[1], /does not exist yet/);
});

test('disable and enable move the folder to the hidden sibling and back (Claude, Codex, Cursor)', POSIX_ONLY, async (t) => {
  const { run, skillNode, state, ws, home } = setup(t);
  const cases = [
    ['release-notes', path.join(ws, '.claude')],
    ['lint-fix', path.join(ws, '.agents')],
    ['commit-msg', path.join(home, '.cursor')],
    ['legacy-skill', path.join(home, '.codex')],
  ];
  for (const [name, parent] of cases) {
    // Cancel first: nothing moves.
    state.ui.warning = () => undefined;
    await run('agentSkills.disable', skillNode(name));
    assert.equal(fs.existsSync(path.join(parent, 'skills', name, 'SKILL.md')), true, `${name} stays on cancel`);

    state.ui.warning = (msg, opts) => {
      assert.match(opts.detail, new RegExp(`\\.disabled-skills/${name}`));
      return 'Disable';
    };
    await run('agentSkills.disable', skillNode(name));
    assert.equal(fs.existsSync(path.join(parent, 'skills', name)), false);
    assert.equal(fs.existsSync(path.join(parent, '.disabled-skills', name, 'SKILL.md')), true);
    assert.equal(skillNode(name).skill.disabled, true, 'tree shows it as disabled after refresh');

    state.ui.info = () => 'Enable';
    await run('agentSkills.enable', skillNode(name));
    assert.equal(fs.existsSync(path.join(parent, 'skills', name, 'SKILL.md')), true);
    assert.equal(skillNode(name).skill.disabled, false);
  }
});

test('disable refuses to overwrite a disabled copy with the same name', POSIX_ONLY, async (t) => {
  const { run, skillNode, state, put, ws } = setup(t);
  put('proj/.claude/.disabled-skills/release-notes/SKILL.md', md('release-notes', 'Old copy.'));
  state.ui.warning = () => 'Disable';
  // Two entries now share the name; skillNode returns the enabled one (listed first).
  const node = skillNode('release-notes');
  assert.equal(node.skill.disabled, false);
  await run('agentSkills.disable', node);
  assert.match(state.calls.find((c) => c[0] === 'error')[1], /already exists/);
  assert.equal(fs.existsSync(path.join(ws, '.claude', 'skills', 'release-notes', 'SKILL.md')), true);
});

test('copyTo copies a user Claude skill into the project Codex folder', POSIX_ONLY, async (t) => {
  const { run, skillNode, state, ws } = setup(t);
  state.ui.quickPick = (items) => {
    assert.ok(!items.some((i) => i.label === '~/.claude/skills'), 'the source folder is not offered');
    return items.find((i) => i.label === '.agents/skills');
  };
  state.ui.info = () => 'Open SKILL.md';
  await run('agentSkills.copyTo', skillNode('pdf-tools'));
  const dest = path.join(ws, '.agents', 'skills', 'pdf-tools');
  assert.equal(fs.readFileSync(path.join(dest, 'scripts', 'run.py'), 'utf8'), 'print(1)\n');
  assert.equal(state.opened.at(-1).file, path.join(dest, 'SKILL.md'));
  assert.match(state.calls.find((c) => c[0] === 'info')[1], /Copied "pdf-tools" to \.agents\/skills \(2 files\)/);
});

test('copyTo does not carry secrets or files outside the skill', POSIX_ONLY, async (t) => {
  const { run, skillNode, state, ws, put, home } = setup(t);
  const skill = path.join(home, '.claude', 'skills', 'pdf-tools');
  put('home/.claude/skills/pdf-tools/.env', 'TOKEN=abc\n');
  put('home/.claude/skills/pdf-tools/.env.example', 'TOKEN=\n');
  put('home/.claude/skills/pdf-tools/assets/server.pem', 'KEY\n');
  const secret = put('home/.ssh/id_ed25519', 'PRIVATE KEY\n');
  fs.symlinkSync(secret, path.join(skill, 'assets', 'key-link'));
  fs.symlinkSync(path.join(skill, 'scripts', 'run.py'), path.join(skill, 'assets', 'run-link.py')); // inside: kept
  state.ui.quickPick = (items) => items.find((i) => i.label === '.cursor/skills');
  await run('agentSkills.copyTo', skillNode('pdf-tools'));
  const dest = path.join(ws, '.cursor', 'skills', 'pdf-tools');
  const files = [];
  const walk = (d, rel) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(d, e.name), r);
      else files.push(r);
    }
  };
  walk(dest, '');
  assert.deepEqual(files.sort(), ['.env.example', 'SKILL.md', 'assets/run-link.py', 'scripts/run.py']);
  const msg = state.calls.find((c) => c[0] === 'info')[1];
  assert.match(msg, /\.env \(may hold secrets\)/);
  assert.match(msg, /assets\/key-link \(link outside the skill\)/);
  for (const f of files) assert.doesNotMatch(fs.readFileSync(path.join(dest, f), 'utf8'), /PRIVATE|TOKEN=abc/);
});

test('create: validates input, writes a SKILL.md that passes validation, opens it', POSIX_ONLY, async (t) => {
  const { run, locationNode, state, ws } = setup(t);
  state.ui.inputBox = (opts) => {
    if (opts.title.endsWith('name')) {
      assert.ok(opts.validateInput('Bad Name'), 'uppercase and spaces are rejected');
      assert.match(opts.validateInput('ui-review'), /already exists/);
      assert.equal(opts.validateInput('api-docs'), null);
      return 'api-docs';
    }
    assert.equal(opts.validateInput('line one\nline two'), 'Use a single line.');
    return 'Writes API docs from route files. Use when: the user asks for API docs.';
  };
  await run('agentSkills.create', locationNode('project', '.cursor/skills'));
  const file = path.join(ws, '.cursor', 'skills', 'api-docs', 'SKILL.md');
  assert.equal(state.opened.at(-1).file, file);
  const text = fs.readFileSync(file, 'utf8');
  const v = validateSkill({ dirName: 'api-docs', skillMdName: 'SKILL.md', text, exists: () => true });
  assert.deepEqual(v.problems.filter((p) => p.severity !== 'info'), []);
  assert.equal(v.description, 'Writes API docs from route files. Use when: the user asks for API docs.');
});

test('create from the palette: cancel at the name prompt writes nothing', POSIX_ONLY, async (t) => {
  const { run, state, ws } = setup(t);
  state.ui.quickPick = (items) => items.find((i) => i.label === '.claude/skills');
  state.ui.inputBox = () => undefined;
  await run('agentSkills.create');
  assert.deepEqual(fs.readdirSync(path.join(ws, '.claude', 'skills')), ['release-notes']);
});

/** Script the four install prompts. */
function scriptInstall(state, { mode = 'install', agents = ['claude-code', 'cursor'], scope = 'project', names = '', choice }) {
  state.ui.inputBox = (opts) => (opts.title.includes('repository') ? 'vercel-labs/agent-skills' : names);
  state.ui.quickPick = (items, opts) => {
    if (opts.title.includes('action')) return items.find((i) => i.id === mode);
    if (opts.title.includes('agents')) return items.filter((i) => agents.includes(i.id));
    if (opts.title.includes('scope')) return items.find((i) => i.id === scope);
    throw new Error('unexpected pick ' + opts.title);
  };
  state.ui.warning = (msg, opts, ...actions) => {
    state.lastModal = { msg, detail: opts.detail, actions };
    return choice;
  };
}

function fakeBin(tmp, names) {
  const bin = path.join(tmp, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  for (const n of names) {
    fs.writeFileSync(path.join(bin, n), '#!/bin/sh\necho should-not-run > "$HOME/ran"\n');
    fs.chmodSync(path.join(bin, n), 0o755);
  }
  process.env.PATH = bin;
}

test('install: "Paste in Terminal" types the command without pressing Enter', POSIX_ONLY, async (t) => {
  const { run, state, ws, tmp, home } = setup(t);
  fakeBin(tmp, ['npx']);
  scriptInstall(state, { names: 'pdf, docx', choice: 'Paste in Terminal' });
  await run('agentSkills.installFromGitHub');
  const expected = 'npx -y skills add vercel-labs/agent-skills -a claude-code -a cursor --skill pdf --skill docx';
  assert.deepEqual(state.lastModal.actions, ['Paste in Terminal', 'Copy Command']);
  assert.match(state.lastModal.detail, new RegExp('^' + expected.replace(/[.-]/g, '\\$&')));
  assert.equal(state.terminals.length, 1);
  const term = state.terminals[0];
  assert.equal(term.opts.cwd, ws);
  assert.deepEqual(term.opts.env, {});
  assert.equal(term.shown, true);
  assert.deepEqual(term.sent, [[expected, false]], 'addNewLine is false: the user presses Enter');
  assert.equal(fs.existsSync(path.join(home, 'ran')), false, 'the extension started no process');
});

test('install: an installed skills CLI, user scope, --list, telemetry setting, copy', POSIX_ONLY, async (t) => {
  const { run, state, tmp } = setup(t);
  fakeBin(tmp, ['skills', 'npx']);
  state.config['install.disableTelemetry'] = true;
  scriptInstall(state, { scope: 'user', agents: ['codex'], choice: 'Copy Command' });
  await run('agentSkills.installFromGitHub');
  assert.equal(state.clipboard, 'DISABLE_TELEMETRY=1 skills add vercel-labs/agent-skills -a codex -g');
  assert.equal(state.terminals.length, 0);

  scriptInstall(state, { mode: 'list', choice: 'Paste in Terminal' });
  await run('agentSkills.installFromGitHub');
  assert.deepEqual(state.terminals[0].sent, [['skills add vercel-labs/agent-skills --list', false]]);
  assert.deepEqual(state.terminals[0].opts.env, { DISABLE_TELEMETRY: '1' });
});

test('install: no npx on PATH still shows the command; cancel and no folder do nothing', POSIX_ONLY, async (t) => {
  const { run, state, tmp } = setup(t);
  fakeBin(tmp, []);
  scriptInstall(state, { choice: undefined });
  await run('agentSkills.installFromGitHub');
  assert.match(state.lastModal.detail, /not found on PATH/);
  assert.equal(state.terminals.length, 0);
  assert.equal(state.clipboard, null);

  state.folders = [];
  scriptInstall(state, { scope: 'user', choice: 'Copy Command' });
  await run('agentSkills.installFromGitHub');
  assert.deepEqual(state.lastModal.actions, ['Copy Command'], 'no terminal without a folder');
  assert.match(state.clipboard, /^npx -y skills add vercel-labs\/agent-skills -a claude-code -a cursor -g$/);
});

test('install rejects a source with shell metacharacters before anything is shown', POSIX_ONLY, async (t) => {
  const { run, state } = setup(t);
  state.ui.inputBox = (opts) => {
    assert.ok(opts.validateInput('evil/repo; rm -rf ~'));
    assert.ok(opts.validateInput('evil/repo$(id)'));
    assert.ok(opts.validateInput('https://example.com/a/b'));
    return undefined;
  };
  await run('agentSkills.installFromGitHub');
  assert.equal(state.terminals.length, 0);
});

test('tooltips escape names, paths and descriptions from disk', POSIX_ONLY, (t) => {
  const { put, api } = setup(t);
  const evilDir = 'x`![p](http:evil.png)`';
  put(`home/.claude/skills/${evilDir}/SKILL.md`, md('evil', '"[run](command:workbench.action.terminal.new) <img src=x onerror=alert(1)> $(zap)"'));
  api._test.refreshNow();
  const tree = api._test.tree;
  let item;
  for (const root of tree.getChildren().filter((n) => n.type === 'root')) {
    for (const loc of tree.getChildren(root)) {
      const locItem = tree.getTreeItem(loc);
      assert.deepEqual(locItem.tooltip.markdownCalls, []);
      for (const s of tree.getChildren(loc)) if (s.skill.dirName === evilDir) item = tree.getTreeItem(s);
    }
  }
  assert.ok(item);
  const tip = item.tooltip;
  assert.deepEqual(tip.markdownCalls, [], 'no disk content goes through appendMarkdown');
  assert.equal(tip.isTrusted, false);
  assert.equal(tip.supportHtml, false);
  assert.equal(tip.supportThemeIcons, false);
  assert.ok(tip.value.includes('\\[run\\]\\(command:workbench.action.terminal.new\\)'));
  assert.ok(tip.value.includes('\\!\\[p\\]\\(http:evil.png\\)'));
  assert.ok(!/[^\\]\]\(/.test(tip.value), 'no unescaped link syntax');
});

test('a SKILL.md that links to a file outside the skill is not read or shown', POSIX_ONLY, (t) => {
  const { put, home, api } = setup(t);
  const secret = put('home/.aws/credentials', '---\nname: leak\ndescription: aws_secret_access_key=SHOULD-NOT-SHOW\n---\nx\n');
  fs.mkdirSync(path.join(home, '.claude', 'skills', 'linked'));
  fs.symlinkSync(secret, path.join(home, '.claude', 'skills', 'linked', 'SKILL.md'));
  api._test.refreshNow();
  const s = api._test
    .results()
    .flatMap((r) => r.skills)
    .find((x) => x.dirName === 'linked');
  assert.equal(s.description, '');
  assert.equal(s.name, 'linked');
  assert.match(s.problems[0].message, /outside the skill folder, so it was not read/);
  const item = api._test.tree.getTreeItem({ type: 'skill', skill: s, location: null });
  assert.doesNotMatch(item.tooltip.value + item.description, /SHOULD-NOT-SHOW/);
});

test('source code: no process spawning, no network, no webview', () => {
  const dir = path.join(__dirname, '..', 'src');
  const files = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(path.join(d, e.name));
      else if (e.name.endsWith('.js')) files.push(path.join(d, e.name));
    }
  };
  walk(dir);
  for (const f of files) {
    const code = fs.readFileSync(f, 'utf8');
    for (const banned of [
      /require\(['"](?:node:)?(?:child_process|http|https|net|tls|dgram|worker_threads)['"]\)/,
      /\bProcessExecution\b|\bShellExecution\b|\bexecuteTask\b/,
      /\bfetch\(|XMLHttpRequest|WebSocket/,
      /createWebviewPanel|registerWebviewViewProvider/,
      /\beval\(|new Function\(/,
    ]) {
      assert.doesNotMatch(code, banned, `${path.basename(f)} matches ${banned}`);
    }
  }
});
