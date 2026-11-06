// @ts-check
'use strict';

const vscode = require('vscode');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { resolveLocations, CLI_AGENTS } = require('./core/locations');
const { scanLocation } = require('./core/scan');
const fsops = require('./core/fsops');
const cli = require('./core/cli');
const bundle = require('./core/bundle');
const { createRatingPrompt } = require('./rate');
const { registerSupport, commandIds, showLinks } = require('./support');

let rating = { success() {} };

/** @typedef {import('./core/scan').SkillInfo} SkillInfo */
/** @typedef {import('./core/locations').ResolvedLocation} ResolvedLocation */
/** @typedef {ReturnType<typeof scanLocation>} LocationResult */

/**
 * @typedef {{ type: 'root', id: string, label: string, description: string, scope: 'project' | 'user', folderPath: string | null }} RootNode
 * @typedef {{ type: 'location', result: LocationResult }} LocationNode
 * @typedef {{ type: 'skill', skill: SkillInfo, location: ResolvedLocation }} SkillNode
 * @typedef {{ type: 'problem', problem: import('./core/validate').Problem, skill: SkillInfo }} ProblemNode
 * @typedef {{ type: 'support' } | { type: 'supportLink', which: 'sponsor' | 'more' }} SupportNode
 * @typedef {RootNode | LocationNode | SkillNode | ProblemNode | SupportNode} Node
 */

const CONFIG = 'agentSkills';

/** @type {LocationResult[]} */
let results = [];
let lastScan = 0;

function home() {
  return os.homedir();
}

function config() {
  return vscode.workspace.getConfiguration(CONFIG);
}

function currentLocations() {
  const folders = (vscode.workspace.workspaceFolders || [])
    .filter((f) => f.uri.scheme === 'file')
    .map((f) => ({ name: f.name, path: f.uri.fsPath }));
  const extra = config().get('extraLocations', []);
  return resolveLocations({ home: home(), workspaceFolders: folders, extraLocations: Array.isArray(extra) ? extra : [] });
}

function scanAll() {
  results = currentLocations().map((loc) => scanLocation(loc));
  lastScan = Date.now();
}

/** A short fingerprint of what the tree shows, to skip redraws when nothing changed. */
function signature() {
  return JSON.stringify(
    results.map((r) => [
      r.location.key,
      r.exists,
      r.truncated,
      r.errors.map(String),
      r.skills.map((s) => [s.dir, s.name, s.description, s.disabled, s.symlink, s.realDir, s.skillMd, s.problems.map((p) => [p.severity, p.code, p.line, p.message])]),
    ])
  );
}

/** @param {string} s @param {number} n */
function truncate(s, n) {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? one.slice(0, n - 1) + '…' : one;
}

/**
 * Hover text. Every value that comes from disk (paths, names, descriptions, errors) goes
 * through appendText, which escapes Markdown. Only our own fixed labels use appendMarkdown.
 * Theme icons, HTML and command links are off.
 * @param {...(string | { b: string })} parts plain text, or { b } for a bold fixed label
 */
function tooltip(...parts) {
  const md = new vscode.MarkdownString('', false);
  md.isTrusted = false;
  md.supportHtml = false;
  for (const p of parts) {
    if (typeof p === 'string') md.appendText(p);
    else md.appendMarkdown(`**${p.b}**`);
  }
  return md;
}

/**
 * QuickPick labels turn $(name) into icons. Text from disk must not, so break the pattern.
 * @param {string} s
 */
function noIcons(s) {
  return String(s).replace(/\$\(/g, '$\u200b(');
}

/** @param {number} n */
function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

/** @param {'error' | 'warning' | 'info' | null} sev */
function severityIcon(sev) {
  if (sev === 'error') return new vscode.ThemeIcon('error', new vscode.ThemeColor('problemsErrorIcon.foreground'));
  if (sev === 'warning') return new vscode.ThemeIcon('warning', new vscode.ThemeColor('problemsWarningIcon.foreground'));
  if (sev === 'info') return new vscode.ThemeIcon('info', new vscode.ThemeColor('problemsInfoIcon.foreground'));
  return new vscode.ThemeIcon('book');
}

/** @implements {vscode.TreeDataProvider<Node>} */
class SkillsTree {
  constructor() {
    /** @type {vscode.EventEmitter<Node | undefined | void>} */
    this.emitter = new vscode.EventEmitter();
    this.onDidChangeTreeData = this.emitter.event;
  }

  fire() {
    this.emitter.fire();
  }

  /** @param {LocationResult} r */
  visible(r) {
    return r.exists || r.skills.length > 0 || config().get('showEmptyLocations', false);
  }

  /** @returns {RootNode[]} */
  roots() {
    /** @type {RootNode[]} */
    const roots = [];
    for (const f of vscode.workspace.workspaceFolders || []) {
      if (f.uri.scheme !== 'file') continue;
      roots.push({ type: 'root', id: `project:${f.uri.fsPath}`, label: f.name, description: 'Project', scope: 'project', folderPath: f.uri.fsPath });
    }
    roots.push({ type: 'root', id: 'user', label: 'User', description: '~', scope: 'user', folderPath: null });
    /** @type {any[]} */
    const shown = roots.filter((r) => this.locationsOf(r).length > 0);
    // One collapsed "Support Skill Shelf" row at the end, only when the list has skills (an empty tree shows the
    // welcome text instead). Setting agentSkills.showSupportLinks hides it.
    if (shown.length && showLinks(vscode, CONFIG)) shown.push({ type: 'support' });
    return shown;
  }

  /** @param {RootNode} root */
  locationsOf(root) {
    return results.filter(
      (r) =>
        r.location.scope === root.scope &&
        (root.scope === 'user' || r.location.folderPath === root.folderPath) &&
        this.visible(r)
    );
  }

  /**
   * Parent of a node, so the view can reveal a skill (Find Skill uses this).
   * @param {Node} el
   * @returns {Node | undefined}
   */
  getParent(el) {
    if (el.type === 'problem') {
      for (const r of results) if (r.skills.includes(el.skill)) return { type: 'skill', skill: el.skill, location: r.location };
      return undefined;
    }
    if (el.type === 'skill') {
      const result = results.find((r) => r.location.key === el.location.key);
      return result ? { type: 'location', result } : undefined;
    }
    if (el.type === 'location') {
      const loc = el.result.location;
      return this.roots().find((r) => r.type === 'root' && r.scope === loc.scope && (loc.scope === 'user' || r.folderPath === loc.folderPath));
    }
    if (el.type === 'supportLink') return { type: 'support' };
    return undefined;
  }

  /** @param {Node} [el] @returns {Node[]} */
  getChildren(el) {
    if (!el) return this.roots();
    if (el.type === 'root') return this.locationsOf(el).map((result) => ({ type: 'location', result }));
    if (el.type === 'location') {
      const loc = el.result.location;
      return el.result.skills.map((skill) => ({ type: 'skill', skill, location: loc }));
    }
    if (el.type === 'skill') return el.skill.problems.map((problem) => ({ type: 'problem', problem, skill: el.skill }));
    if (el.type === 'support') return [{ type: 'supportLink', which: 'sponsor' }, { type: 'supportLink', which: 'more' }];
    return [];
  }

  /** @param {Node} el @returns {vscode.TreeItem} */
  getTreeItem(el) {
    if (el.type === 'support') {
      const item = new vscode.TreeItem('Support Skill Shelf', vscode.TreeItemCollapsibleState.Collapsed);
      item.id = 'support';
      item.description = 'Sponsor · More free viewers';
      item.tooltip = 'Sponsor the developer on GitHub, or install another free Zovo extension. Turn off agentSkills.showSupportLinks to hide this row.';
      item.iconPath = new vscode.ThemeIcon('heart');
      item.contextValue = 'support';
      return item;
    }
    if (el.type === 'supportLink') {
      const c = commandIds(CONFIG);
      const sponsor = el.which === 'sponsor';
      const item = new vscode.TreeItem(sponsor ? 'Sponsor' : 'More free viewers', vscode.TreeItemCollapsibleState.None);
      item.id = `support:${el.which}`;
      item.description = sponsor ? 'GitHub Sponsors' : 'Other extensions by Zovo';
      item.iconPath = new vscode.ThemeIcon(sponsor ? 'link-external' : 'extensions');
      item.contextValue = 'supportLink';
      item.command = { command: sponsor ? c.sponsor : c.more, title: item.label };
      return item;
    }
    if (el.type === 'root') {
      const item = new vscode.TreeItem(el.label, vscode.TreeItemCollapsibleState.Expanded);
      item.id = el.id;
      item.description = el.description;
      item.iconPath = new vscode.ThemeIcon(el.scope === 'user' ? 'account' : 'root-folder');
      item.contextValue = 'root';
      return item;
    }
    if (el.type === 'location') {
      const r = el.result;
      const loc = r.location;
      const enabled = r.skills.filter((s) => !s.disabled).length;
      const disabled = r.skills.length - enabled;
      const item = new vscode.TreeItem(loc.display, vscode.TreeItemCollapsibleState.Expanded);
      item.id = `loc:${loc.key}`;
      const counts = `${enabled} skill${enabled === 1 ? '' : 's'}` + (disabled ? `, ${disabled} disabled` : '');
      item.description = r.exists || r.skills.length ? `${counts} · ${loc.agents.join(', ')}` : `not created · ${loc.agents.join(', ')}`;
      const parts = [
        loc.display,
        `\n\nPath: ${loc.dir}\n\nRead by: ${loc.agents.join(', ')}\n\nDisabled skills are kept in ${loc.disabledDir}`,
      ];
      if (r.truncated) parts.push('\n\nOnly the first 1,000 entries are shown.');
      for (const e of r.errors) parts.push(`\n\n${String(e)}`);
      item.tooltip = tooltip(...parts);
      item.iconPath = new vscode.ThemeIcon(loc.custom ? 'folder-library' : 'folder');
      item.contextValue = 'location';
      return item;
    }
    if (el.type === 'skill') {
      const s = el.skill;
      const item = new vscode.TreeItem(
        s.name,
        s.problems.length ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None
      );
      item.id = `skill:${s.dir}`;
      item.description = (s.disabled ? 'disabled · ' : '') + truncate(s.description || '(no description)', 90);
      const parts = [s.name + (s.disabled ? ' (disabled)' : '') + '\n\n'];
      if (s.description) parts.push(s.description.slice(0, 1100) + '\n\n');
      parts.push(`Folder: ${s.dir}`);
      if (s.symlink) parts.push(`\n\nSymbolic link to: ${s.realDir || 'missing target'}`);
      const counts = { error: 0, warning: 0, info: 0 };
      for (const p of s.problems) counts[p.severity]++;
      if (s.problems.length) {
        parts.push(`\n\n${counts.error} error(s), ${counts.warning} warning(s), ${counts.info} note(s)`);
      }
      item.tooltip = tooltip(...parts);
      item.iconPath = s.disabled ? new vscode.ThemeIcon('circle-slash') : severityIcon(s.severity);
      item.contextValue = s.disabled ? 'skill.disabled' : 'skill.enabled';
      if (s.skillMd) {
        item.resourceUri = vscode.Uri.file(s.skillMd);
        item.command = { command: 'agentSkills.open', title: 'Open SKILL.md', arguments: [el] };
      }
      return item;
    }
    const p = el.problem;
    const item = new vscode.TreeItem(p.message, vscode.TreeItemCollapsibleState.None);
    item.description = `line ${p.line}`;
    item.tooltip = `${p.severity}: ${p.message} (${p.code}, line ${p.line})`;
    item.iconPath = severityIcon(p.severity);
    item.contextValue = 'problem';
    if (el.skill.skillMd) {
      item.command = { command: 'agentSkills.openAtLine', title: 'Go to problem', arguments: [el.skill.skillMd, p.line] };
    }
    return item;
  }
}

/** @param {vscode.DiagnosticCollection} diags */
function updateDiagnostics(diags) {
  diags.clear();
  const mode = config().get('diagnostics', 'workspace');
  if (mode === 'off') return;
  for (const r of results) {
    if (mode === 'workspace' && r.location.scope !== 'project') continue;
    for (const s of r.skills) {
      if (!s.skillMd || s.disabled) continue;
      const list = s.problems.map((p) => {
        const line = Math.max(0, p.line - 1);
        const d = new vscode.Diagnostic(
          new vscode.Range(line, 0, line, 1000),
          p.message,
          p.severity === 'error'
            ? vscode.DiagnosticSeverity.Error
            : p.severity === 'warning'
              ? vscode.DiagnosticSeverity.Warning
              : vscode.DiagnosticSeverity.Information
        );
        d.source = 'Agent Skills';
        d.code = p.code;
        return d;
      });
      if (list.length) diags.set(vscode.Uri.file(s.skillMd), list);
    }
  }
}

function requireTrust() {
  if (vscode.workspace.isTrusted) return true;
  void vscode.window.showWarningMessage(
    'Agent Skills Manager is read-only in Restricted Mode. Trust this workspace to change, copy, create or install skills.'
  );
  return false;
}

/** @param {unknown} e */
function errorText(e) {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Let the user pick a skill when a command runs from the Command Palette.
 * @param {(s: SkillInfo) => boolean} filter
 * @param {string} placeHolder
 * @returns {Promise<SkillNode | undefined>}
 */
async function pickSkill(filter, placeHolder) {
  /** @type {(vscode.QuickPickItem & { node: SkillNode })[]} */
  const items = [];
  for (const r of results) {
    for (const s of r.skills) {
      if (!filter(s)) continue;
      items.push({
        label: s.name,
        description: (r.location.scope === 'user' ? '' : `${r.location.folderName} · `) + r.location.display + (s.disabled ? ' (disabled)' : ''),
        detail: truncate(s.description, 120),
        node: { type: 'skill', skill: s, location: r.location },
      });
    }
  }
  if (items.length === 0) {
    void vscode.window.showInformationMessage('No matching skills found.');
    return undefined;
  }
  const picked = await vscode.window.showQuickPick(items, { placeHolder, matchOnDescription: true, matchOnDetail: true });
  return picked ? picked.node : undefined;
}

/**
 * @param {Node | undefined} arg
 * @param {(s: SkillInfo) => boolean} filter
 * @param {string} placeHolder
 */
async function skillArg(arg, filter, placeHolder) {
  if (arg && arg.type === 'skill') return arg;
  return pickSkill(filter, placeHolder);
}

/**
 * Pick a skills folder.
 * @param {string} placeHolder
 * @param {(loc: ResolvedLocation) => boolean} filter
 * @returns {Promise<ResolvedLocation | undefined>}
 */
async function pickLocation(placeHolder, filter, ignoreFocusOut = false) {
  const locs = results.map((r) => ({ loc: r.location, exists: r.exists })).filter((x) => filter(x.loc));
  if (locs.length === 0) {
    void vscode.window.showInformationMessage('No skill folders are available. Open a folder or check agentSkills.extraLocations.');
    return undefined;
  }
  const items = locs.map((x) => ({
    label: x.loc.display,
    description: (x.loc.scope === 'user' ? 'User' : `Project · ${x.loc.folderName}`) + (x.exists ? '' : ' · will be created'),
    detail: `Read by: ${x.loc.agents.join(', ')}`,
    loc: x.loc,
  }));
  const picked = await vscode.window.showQuickPick(items, { placeHolder, matchOnDescription: true, matchOnDetail: true, ignoreFocusOut });
  return picked ? picked.loc : undefined;
}

/** @param {SkillNode} node */
function locationOf(node) {
  return node.location;
}

/**
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
  rating = createRatingPrompt({ vscode, context, extensionId: 'zovo.skill-shelf', section: 'agentSkills', message: (n) => `Skill Shelf has listed your skills ${n} times for you. A rating helps other people find it.` });
  let ratedThisSession = false; // one success per session: the tree is visible and shows at least one skill
  const countSuccess = (total) => { if (!ratedThisSession && total > 0 && view.visible) { ratedThisSession = true; rating.success(); } };
  registerSupport({ vscode, context, prefix: CONFIG, selfId: 'zovo.skill-shelf' });
  const tree = new SkillsTree();
  const diags = vscode.languages.createDiagnosticCollection('agentSkills');
  const view = vscode.window.createTreeView('agentSkills.tree', { treeDataProvider: tree, showCollapseAll: true });
  const skillCount = () => (results || []).reduce((n, r) => n + r.skills.length, 0);
  if (typeof view.onDidChangeVisibility === 'function') {
    context.subscriptions.push(view.onDidChangeVisibility((e) => { if (e.visible) countSuccess(skillCount()); }));
  }

  /** @type {NodeJS.Timeout | undefined} */
  let timer;
  // force = false (background refreshes: file watcher, window focus, settings) redraws the tree only when
  // the scan found a change. Redrawing on every window focus is wasted work and can close an open search box.
  const refreshNow = (force = true) => {
    const before = signature();
    try {
      scanAll();
    } catch (e) {
      void vscode.window.showErrorMessage(`Agent Skills: scan failed: ${errorText(e)}`);
      return;
    }
    if (!force && signature() === before) return;
    tree.fire();
    updateDiagnostics(diags);
    const total = results.reduce((n, r) => n + r.skills.filter((s) => !s.disabled).length, 0);
    view.description = total ? `${total} enabled` : undefined;
    countSuccess(skillCount());
  };
  let pendingForce = false;
  const scheduleRefresh = (delay = 300, force = false) => {
    if (timer) clearTimeout(timer);
    pendingForce = pendingForce || force;
    timer = setTimeout(() => {
      const f = pendingForce;
      pendingForce = false;
      refreshNow(f);
    }, delay);
  };

  const watcher = vscode.workspace.createFileSystemWatcher('**/{SKILL.md,skill.md}');
  watcher.onDidCreate(() => scheduleRefresh());
  watcher.onDidChange(() => scheduleRefresh());
  watcher.onDidDelete(() => scheduleRefresh());

  /** @type {Set<vscode.Terminal>} */
  const ourTerminals = new Set();

  const reg = (/** @type {string} */ id, /** @type {(...args: any[]) => any} */ fn) =>
    context.subscriptions.push(vscode.commands.registerCommand(id, fn));

  reg('agentSkills.refresh', () => refreshNow(true));

  reg('agentSkills.open', async (/** @type {Node | undefined} */ arg) => {
    const node = await skillArg(arg, () => true, 'Open which skill?');
    if (!node) return;
    if (!node.skill.skillMd) {
      void vscode.window.showWarningMessage(`"${node.skill.name}" has no SKILL.md.`);
      return;
    }
    await vscode.window.showTextDocument(vscode.Uri.file(node.skill.skillMd), { preview: true });
  });

  reg('agentSkills.openAtLine', async (/** @type {string} */ file, /** @type {number} */ line) => {
    if (typeof file !== 'string') return;
    // Only open SKILL.md files the scan found, so other callers cannot use this to open any file.
    if (!results.some((r) => r.skills.some((s) => s.skillMd === file))) return;
    const l = Math.max(0, (Number(line) || 1) - 1);
    await vscode.window.showTextDocument(vscode.Uri.file(file), { selection: new vscode.Range(l, 0, l, 0), preview: true });
  });

  reg('agentSkills.reveal', async (/** @type {Node | undefined} */ arg) => {
    let target;
    if (arg && arg.type === 'location') target = arg.result.location.dir;
    else {
      const node = await skillArg(arg, () => true, 'Reveal which skill?');
      if (!node) return;
      target = node.skill.dir;
    }
    if (!fs.existsSync(target)) {
      void vscode.window.showInformationMessage(`${target} does not exist yet.`);
      return;
    }
    await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(target));
  });

  reg('agentSkills.disable', async (/** @type {Node | undefined} */ arg) => {
    if (!requireTrust()) return;
    const node = await skillArg(arg, (s) => !s.disabled, 'Disable which skill?');
    if (!node || node.skill.disabled) return;
    const loc = locationOf(node);
    const dest = path.join(loc.disabledDir, path.basename(node.skill.dir));
    const choice = await vscode.window.showWarningMessage(
      `Disable "${node.skill.name}"?`,
      {
        modal: true,
        detail: `The folder moves from\n${node.skill.dir}\nto\n${dest}\n\nAgents stop loading it. "Enable" moves it back.`,
      },
      'Disable'
    );
    if (choice !== 'Disable') return;
    try {
      fsops.moveSkill(node.skill.dir, loc.disabledDir);
    } catch (e) {
      void vscode.window.showErrorMessage(`Could not disable the skill: ${errorText(e)}`);
    }
    refreshNow();
  });

  reg('agentSkills.enable', async (/** @type {Node | undefined} */ arg) => {
    if (!requireTrust()) return;
    const node = await skillArg(arg, (s) => s.disabled, 'Enable which skill?');
    if (!node || !node.skill.disabled) return;
    const loc = locationOf(node);
    const dest = path.join(loc.dir, path.basename(node.skill.dir));
    const choice = await vscode.window.showInformationMessage(
      `Enable "${node.skill.name}"?`,
      { modal: true, detail: `The folder moves from\n${node.skill.dir}\nto\n${dest}` },
      'Enable'
    );
    if (choice !== 'Enable') return;
    try {
      fsops.moveSkill(node.skill.dir, loc.dir);
    } catch (e) {
      void vscode.window.showErrorMessage(`Could not enable the skill: ${errorText(e)}`);
    }
    refreshNow();
  });

  reg('agentSkills.copyTo', async (/** @type {Node | undefined} */ arg) => {
    if (!requireTrust()) return;
    const node = await skillArg(arg, () => true, 'Copy which skill?');
    if (!node) return;
    const src = node.location;
    const target = await pickLocation(`Copy "${node.skill.name}" to…`, (l) => l.key !== src.key);
    if (!target) return;
    try {
      const res = fsops.copySkill(node.skill.dir, target.dir);
      refreshNow();
      const skippedNote = res.skipped.length ? ` Skipped: ${res.skipped.slice(0, 5).join(', ')}${res.skipped.length > 5 ? '…' : ''}.` : '';
      const pick = await vscode.window.showInformationMessage(
        `Copied "${node.skill.name}" to ${target.display} (${res.files} files).${skippedNote}`,
        'Open SKILL.md'
      );
      if (pick === 'Open SKILL.md') {
        const md = path.join(res.dest, 'SKILL.md');
        if (fs.existsSync(md)) await vscode.window.showTextDocument(vscode.Uri.file(md));
      }
    } catch (e) {
      void vscode.window.showErrorMessage(`Could not copy the skill: ${errorText(e)}`);
    }
  });

  reg('agentSkills.create', async (/** @type {Node | undefined} */ arg) => {
    if (!requireTrust()) return;
    /** @type {ResolvedLocation | undefined} */
    let loc = arg && arg.type === 'location' ? arg.result.location : undefined;
    if (!loc) loc = await pickLocation('Create the skill in…', () => true);
    if (!loc) return;
    const target = loc;
    const name = await vscode.window.showInputBox({
      title: 'New skill: name',
      prompt: 'Lowercase letters, digits and hyphens. This is also the folder name.',
      placeHolder: 'my-skill',
      validateInput: (v) => {
        const err = fsops.newSkillNameError(v);
        if (err) return err;
        if (fs.existsSync(path.join(target.dir, v))) return `"${v}" already exists in ${target.display}.`;
        return null;
      },
    });
    if (name === undefined) return;
    const description = await vscode.window.showInputBox({
      title: 'New skill: description',
      prompt: 'What the skill does and when an agent should use it (max 1024 characters).',
      placeHolder: 'Formats release notes from merged PRs. Use when the user asks for a changelog.',
      validateInput: (v) => fsops.newDescriptionError(v),
    });
    if (description === undefined) return;
    try {
      const file = fsops.createSkill(target.dir, name, description);
      refreshNow();
      await vscode.window.showTextDocument(vscode.Uri.file(file));
    } catch (e) {
      void vscode.window.showErrorMessage(`Could not create the skill: ${errorText(e)}`);
    }
  });

  // Find Skill: one search box over every skill in every folder, by name, description, folder or agent.
  reg('agentSkills.find', async () => {
    // Rescan when the list may be stale, but redraw the tree only when something changed:
    // a redraw while the search box opens can move focus and close it.
    if (Date.now() - lastScan > 2000) refreshNow(false);
    /** @type {(vscode.QuickPickItem & { node: SkillNode })[]} */
    const items = [];
    for (const r of results) {
      for (const s of r.skills) {
        const icon = s.disabled ? 'circle-slash' : s.severity === 'error' ? 'error' : s.severity === 'warning' ? 'warning' : 'book';
        const errors = s.problems.filter((p) => p.severity === 'error').length;
        const warnings = s.problems.filter((p) => p.severity === 'warning').length;
        const issues = [errors ? `${errors} error${errors === 1 ? '' : 's'}` : '', warnings ? `${warnings} warning${warnings === 1 ? '' : 's'}` : ''].filter(Boolean).join(', ');
        items.push({
          label: `$(${icon}) ${noIcons(s.name)}`,
          description: noIcons(
            (r.location.scope === 'user' ? 'User · ' : `${r.location.folderName} · `) + r.location.display + (s.disabled ? ' · disabled' : '') + (issues ? ` · ${issues}` : '')
          ),
          detail: noIcons(`${truncate(s.description || '(no description)', 140)} · ${r.location.agents.join(', ')}`),
          buttons: [
            { iconPath: new vscode.ThemeIcon('open-preview'), tooltip: 'Preview SKILL.md' },
            { iconPath: new vscode.ThemeIcon('list-tree'), tooltip: 'Show in the Agent Skills view' },
          ],
          node: { type: 'skill', skill: s, location: r.location },
        });
      }
    }
    if (items.length === 0) {
      void vscode.window.showInformationMessage('No agent skills found. Create one or install some first.');
      return;
    }
    const qp = vscode.window.createQuickPick();
    qp.title = 'Find Skill';
    qp.placeholder = `Search ${items.length} skill${items.length === 1 ? '' : 's'} by name, description, folder or agent`;
    qp.matchOnDescription = true;
    qp.matchOnDetail = true;
    qp.items = items;
    /** @type {Promise<void>} */
    const done = new Promise((resolve) => {
      qp.onDidTriggerItemButton(async (e) => {
        const node = /** @type {any} */ (e.item).node;
        qp.hide();
        if (e.button.tooltip === 'Preview SKILL.md') await vscode.commands.executeCommand('agentSkills.preview', node);
        else await showInView(node);
      });
      qp.onDidAccept(async () => {
        const item = /** @type {any} */ (qp.selectedItems[0] || qp.activeItems[0]);
        qp.hide();
        if (!item) return;
        if (item.node.skill.skillMd) await vscode.commands.executeCommand('agentSkills.open', item.node);
        else await showInView(item.node);
      });
      qp.onDidHide(() => {
        qp.dispose();
        resolve();
      });
    });
    qp.show();
    await done;
  });

  /** @param {SkillNode} node */
  const showInView = async (node) => {
    await vscode.commands.executeCommand('agentSkills.tree.focus');
    try {
      await view.reveal(node, { select: true, focus: true, expand: false });
    } catch {
      // The tree may still be loading; the view is focused either way.
    }
  };

  reg('agentSkills.preview', async (/** @type {Node | undefined} */ arg) => {
    const node = await skillArg(arg, (s) => !!s.skillMd, 'Preview which skill?');
    if (!node) return;
    if (!node.skill.skillMd) {
      void vscode.window.showWarningMessage(`"${node.skill.name}" has no SKILL.md.`);
      return;
    }
    await vscode.commands.executeCommand('markdown.showPreview', vscode.Uri.file(node.skill.skillMd));
  });

  reg('agentSkills.exportBundle', async (/** @type {Node | undefined} */ arg) => {
    if (!requireTrust()) return;
    const node = await skillArg(arg, (s) => !!s.skillMd, 'Export which skill as a .skill file?');
    if (!node) return;
    const folder = path.basename(node.skill.dir);
    const ws = (vscode.workspace.workspaceFolders || []).find((f) => f.uri.scheme === 'file');
    const uri = await vscode.window.showSaveDialog({
      title: `Export "${node.skill.name}" as a skill bundle`,
      saveLabel: 'Export',
      defaultUri: vscode.Uri.file(path.join(ws ? ws.uri.fsPath : home(), `${folder}.skill`)),
      filters: { 'Skill bundle': ['skill'], 'ZIP archive': ['zip'] },
    });
    if (!uri) return;
    const out = uri.fsPath;
    try {
      if (fsops.isInside(fs.realpathSync(node.skill.dir), fsops.realpathLoose(path.dirname(out)))) {
        void vscode.window.showErrorMessage('Save the bundle outside the skill folder. Agents would load it as part of the skill.');
        return;
      }
      const res = bundle.exportSkill(node.skill.dir);
      fs.writeFileSync(out, res.buffer);
      const skippedNote = res.skipped.length ? ` Left out: ${res.skipped.slice(0, 5).join(', ')}${res.skipped.length > 5 ? '…' : ''}.` : '';
      const errorNote = node.skill.severity === 'error' ? ' The skill has errors, so agents may skip it. Check them before you share it.' : '';
      const pick = await vscode.window.showInformationMessage(
        `Exported "${node.skill.name}" to ${path.basename(out)} (${res.files} file${res.files === 1 ? '' : 's'}, ${formatBytes(res.buffer.length)}).${skippedNote}${errorNote}`,
        'Reveal in File Explorer'
      );
      if (pick === 'Reveal in File Explorer') await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(out));
    } catch (e) {
      void vscode.window.showErrorMessage(`Could not export the skill: ${errorText(e)}`);
    }
  });

  reg('agentSkills.installBundle', async (/** @type {any} */ arg) => {
    if (!requireTrust()) return;
    /** @type {ResolvedLocation | undefined} */
    let target = arg && arg.type === 'location' ? arg.result.location : undefined;
    /** @type {string | undefined} */
    let file = arg && typeof arg.fsPath === 'string' && arg.scheme === 'file' ? arg.fsPath : undefined;
    if (!file) {
      const picked = await vscode.window.showOpenDialog({
        title: 'Install a skill from a .skill or .zip file',
        openLabel: 'Install',
        canSelectMany: false,
        canSelectFolders: false,
        filters: { 'Skill bundle': ['skill', 'zip'] },
      });
      if (!picked || picked.length === 0) return;
      file = picked[0].fsPath;
    }
    const fileName = path.basename(file);
    let plan;
    try {
      plan = bundle.planBundle(bundle.readBundleFile(file), { bundleName: fileName });
    } catch (e) {
      void vscode.window.showErrorMessage(`Could not read ${fileName}: ${errorText(e)}`);
      return;
    }
    let chosen = plan.skills;
    if (plan.skills.length > 1) {
      const picks = await vscode.window.showQuickPick(
        plan.skills.map((s) => ({
          label: noIcons(s.folder),
          description: `${s.files.length} file${s.files.length === 1 ? '' : 's'}${s.severity === 'error' ? ' · has errors' : ''}`,
          detail: noIcons(truncate(s.description || '(no description)', 140)),
          picked: true,
          skill: s,
        })),
        { title: `${fileName} holds ${plan.skills.length} skills`, canPickMany: true, placeHolder: 'Choose the skills to install', ignoreFocusOut: true }
      );
      if (!picks || picks.length === 0) return;
      chosen = picks.map((p) => p.skill);
    }
    const what = chosen.length === 1 ? `"${chosen[0].folder}"` : `${chosen.length} skills`;
    // Started from an Explorer or tree menu, the closing menu can take focus back: keep the picker open until Esc.
    if (!target) target = await pickLocation(`Install ${what} into…`, () => true, true);
    if (!target) return;
    const lines = chosen.map((s) => {
      const errs = s.problems.filter((p) => p.severity === 'error').length;
      return `${s.folder}: ${s.files.length} file${s.files.length === 1 ? '' : 's'}${errs ? `, ${errs} error${errs === 1 ? '' : 's'} in SKILL.md` : ''}`;
    });
    const skippedNote = plan.skipped.length
      ? `\n\nLeft out: ${plan.skipped.slice(0, 8).join(', ')}${plan.skipped.length > 8 ? ` and ${plan.skipped.length - 8} more` : ''}.`
      : '';
    const choice = await vscode.window.showWarningMessage(
      `Install ${what} from ${fileName}?`,
      {
        modal: true,
        detail:
          `${lines.join('\n')}\n\nInto: ${target.dir}\nRead by: ${target.agents.join(', ')}${skippedNote}\n\n` +
          'Nothing that exists is overwritten. Skills can include scripts that your agent may run, so read the files before you use them.',
      },
      'Install'
    );
    if (choice !== 'Install') return;
    try {
      const done = bundle.installBundle(chosen, target.dir);
      refreshNow();
      const pick = await vscode.window.showInformationMessage(
        `Installed ${what} into ${target.display} (${done.reduce((n, d) => n + d.files, 0)} files).`,
        'Open SKILL.md'
      );
      if (pick === 'Open SKILL.md') {
        const md = path.join(done[0].dest, 'SKILL.md');
        if (fs.existsSync(md)) await vscode.window.showTextDocument(vscode.Uri.file(md));
      }
    } catch (e) {
      void vscode.window.showErrorMessage(`Could not install from ${fileName}: ${errorText(e)}`);
    }
  });

  reg('agentSkills.installFromGitHub', async () => {
    if (!requireTrust()) return;
    const isFile = (/** @type {string} */ p) => {
      try {
        if (!fs.statSync(p).isFile()) return false;
        if (process.platform !== 'win32') fs.accessSync(p, fs.constants.X_OK);
        return true;
      } catch {
        return false;
      }
    };
    const env = { PATH: process.env.PATH, PATHEXT: process.env.PATHEXT };
    // PATH lookup only (no process is started): prefer an installed `skills`, else `npx -y skills`.
    const runner = cli.chooseRunner({
      skillsPath: cli.findOnPath('skills', env, process.platform, isFile),
      npxPath: cli.findOnPath('npx', env, process.platform, isFile),
    }) || { program: 'npx', prefix: ['-y', 'skills'], label: 'npx (not found on PATH: install Node.js 22.20 or newer first)' };

    const sourceInput = await vscode.window.showInputBox({
      title: 'Install skills from GitHub (1/4): repository',
      prompt: 'owner/repo, owner/repo@tag, or a https://github.com/… URL',
      placeHolder: 'vercel-labs/agent-skills',
      validateInput: (v) => {
        const r = cli.validateSource(v);
        return r.ok ? null : r.error;
      },
    });
    if (sourceInput === undefined) return;
    const source = cli.validateSource(sourceInput);
    if (!source.ok) return;

    const mode = await vscode.window.showQuickPick(
      [
        { label: 'Install skills', id: 'install' },
        { label: 'Only list the skills in this repository', description: 'adds --list; installs nothing', id: 'list' },
      ],
      { title: 'Install skills from GitHub (2/4): action' }
    );
    if (!mode) return;

    /** @type {string[]} */
    let agents = [];
    let global = false;
    /** @type {string[]} */
    let skills = [];
    if (mode.id === 'install') {
      const agentPicks = await vscode.window.showQuickPick(
        CLI_AGENTS.map((a) => ({ label: a.label, description: `project ${a.project} · user ${a.user}`, id: a.id })),
        { title: 'Install skills from GitHub (3/4): agents', canPickMany: true, placeHolder: 'Choose one or more agents' }
      );
      if (!agentPicks || agentPicks.length === 0) return;
      agents = agentPicks.map((a) => a.id);
      const scope = await vscode.window.showQuickPick(
        [
          { label: 'Project', description: 'this workspace folder', id: 'project' },
          { label: 'User (global)', description: 'your home folder, adds -g', id: 'user' },
        ],
        { title: 'Install skills from GitHub (4/4): scope' }
      );
      if (!scope) return;
      global = scope.id === 'user';
      const names = await vscode.window.showInputBox({
        title: 'Skill names (optional)',
        prompt: 'Comma-separated skill names. Leave empty and the CLI asks which skills to install.',
        validateInput: (v) => {
          const r = cli.parseSkillNames(v);
          return r.ok ? null : r.error;
        },
      });
      if (names === undefined) return;
      const parsed = cli.parseSkillNames(names);
      if (!parsed.ok) return;
      skills = parsed.value;
    }

    const folders = (vscode.workspace.workspaceFolders || []).filter((f) => f.uri.scheme === 'file');
    /** @type {vscode.WorkspaceFolder | undefined} */
    let folder = folders[0];
    if (folders.length > 1) {
      folder = await vscode.window.showWorkspaceFolderPick({ placeHolder: 'Run the command in which folder?' });
      if (!folder) return;
    }
    // The extension never starts the CLI itself. It builds the command, shows it, and either
    // copies it or types it into a new terminal without pressing Enter. You run it.
    const program = runner.prefix.length ? 'npx' : 'skills';
    const args = [...runner.prefix, ...cli.buildAddArgs({ source: source.value, agents, global, skills, listOnly: mode.id === 'list' })];
    /** @type {Record<string, string>} */
    const extraEnv = config().get('install.disableTelemetry', false) ? { DISABLE_TELEMETRY: '1' } : {};
    const shown = cli.formatCommand(program, args, extraEnv, process.platform);
    const typed = cli.formatCommand(program, args, {}, process.platform);
    const where = folder ? `Working folder: ${folder.uri.fsPath}` : 'No folder is open: run it from the folder you want.';

    const actions = folder ? ['Paste in Terminal', 'Copy Command'] : ['Copy Command'];
    const choice = await vscode.window.showWarningMessage(
      'Install skills with this command?',
      {
        modal: true,
        detail:
          `${shown}\n\n${where}\nRunner: ${runner.label}\n\n` +
          'Nothing runs yet. "Paste in Terminal" types the command into a new terminal; you press Enter to run it. ' +
          'The skills CLI downloads files from GitHub and writes them into agent skill folders. ' +
          'It needs Node.js 22.20 or newer. Skills can include scripts that agents run: review the repository first.',
      },
      ...actions
    );
    if (choice === 'Copy Command') {
      await vscode.env.clipboard.writeText(shown);
      void vscode.window.showInformationMessage('Command copied. Run it in a terminal, then click Refresh in the Agent Skills view.');
      return;
    }
    if (choice !== 'Paste in Terminal' || !folder) return;
    const terminal = vscode.window.createTerminal({ name: 'Agent Skills', cwd: folder.uri.fsPath, env: { ...extraEnv } });
    ourTerminals.add(terminal);
    terminal.show();
    terminal.sendText(typed, false);
  });

  context.subscriptions.push(
    view,
    diags,
    watcher,
    vscode.window.onDidCloseTerminal((t) => {
      if (!ourTerminals.delete(t)) return;
      refreshNow();
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration(CONFIG)) scheduleRefresh(50, true);
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => scheduleRefresh(50, true)),
    vscode.workspace.onDidGrantWorkspaceTrust(() => scheduleRefresh(50, true)),
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (/^skill\.md$/i.test(path.basename(doc.uri.fsPath))) scheduleRefresh();
    }),
    vscode.window.onDidChangeWindowState((s) => {
      if (s.focused && Date.now() - lastScan > 5000) scheduleRefresh();
    }),
    { dispose: () => timer && clearTimeout(timer) }
  );

  scheduleRefresh(0, true);
  return { _test: { results: () => results, refreshNow, tree } };
}

function deactivate() {}

module.exports = { activate, deactivate };
