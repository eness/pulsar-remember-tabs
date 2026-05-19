'use babel';

import fs from 'fs';
import { CompositeDisposable } from 'atom';

const CONFIG_KEY = 'remember-tabs.savedTabs';
const SAVE_DELAY_MS = 250;
const RESTORE_DELAY_MS = 750;

export default {
  subscriptions: null,
  saveTimer: null,
  restoreTimer: null,
  isRestoring: false,
  readyToSave: false,
  savedTabsFromState: [],

  activate(state = {}) {
    this.subscriptions = new CompositeDisposable();
    this.saveTimer = null;
    this.restoreTimer = null;
    this.isRestoring = false;
    this.readyToSave = false;
    this.savedTabsFromState = this.normalizeTabs(state.savedTabs);

    this.registerWorkspaceListeners();

    this.subscriptions.add(atom.commands.add('atom-workspace', {
      'remember-tabs:restore': () => this.restoreSavedTabs()
    }));

    this.restoreTimer = setTimeout(() => {
      this.restoreTimer = null;
      this.restoreSavedTabs();
    }, RESTORE_DELAY_MS);
  },

  deactivate() {
    if (this.restoreTimer) {
      clearTimeout(this.restoreTimer);
      this.restoreTimer = null;
    }

    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }

    if (this.readyToSave) {
      this.saveOpenTabs();
    }

    if (this.subscriptions) {
      this.subscriptions.dispose();
      this.subscriptions = null;
    }
  },

  serialize() {
    const savedTabs = this.readyToSave ? this.saveOpenTabs() : this.getSavedTabs();
    return { savedTabs };
  },

  registerWorkspaceListeners() {
    this.addDisposable(atom.workspace.onDidAddPaneItem, () => this.scheduleSave());
    this.addDisposable(atom.workspace.onDidDestroyPaneItem, () => this.scheduleSave());
    this.addDisposable(atom.workspace.onDidChangeActivePaneItem, () => this.scheduleSave());
    this.addDisposable(atom.workspace.onDidStopChangingActivePaneItem, () => this.scheduleSave());

    if (typeof atom.workspace.observePanes === 'function') {
      this.subscriptions.add(atom.workspace.observePanes(pane => this.observePane(pane)));
    }

    if (typeof atom.workspace.observeTextEditors === 'function') {
      this.subscriptions.add(atom.workspace.observeTextEditors(editor => this.observeTextEditor(editor)));
    }
  },

  observePane(pane) {
    const paneSubscriptions = new CompositeDisposable();

    this.addPaneDisposable(paneSubscriptions, pane, 'onDidAddItem', () => this.scheduleSave());
    this.addPaneDisposable(paneSubscriptions, pane, 'onDidRemoveItem', () => this.scheduleSave());
    this.addPaneDisposable(paneSubscriptions, pane, 'onDidMoveItem', () => this.scheduleSave());
    this.addPaneDisposable(paneSubscriptions, pane, 'onWillDestroyItem', () => this.scheduleSave());
    this.addPaneDisposable(paneSubscriptions, pane, 'onDidChangeActiveItem', () => this.scheduleSave());

    if (typeof pane.onDidDestroy === 'function') {
      paneSubscriptions.add(pane.onDidDestroy(() => paneSubscriptions.dispose()));
    }

    this.subscriptions.add(paneSubscriptions);
  },

  observeTextEditor(editor) {
    const editorSubscriptions = new CompositeDisposable();

    if (typeof editor.onDidChange === 'function') {
      editorSubscriptions.add(editor.onDidChange(() => {
        if (this.isUntitledTextEditor(editor)) {
          this.scheduleSave();
        }
      }));
    }

    if (typeof editor.onDidChangePath === 'function') {
      editorSubscriptions.add(editor.onDidChangePath(() => this.scheduleSave()));
    }

    if (typeof editor.onDidDestroy === 'function') {
      editorSubscriptions.add(editor.onDidDestroy(() => editorSubscriptions.dispose()));
    }

    this.subscriptions.add(editorSubscriptions);
  },

  addDisposable(subscribe, callback) {
    if (typeof subscribe === 'function') {
      this.subscriptions.add(subscribe.call(atom.workspace, callback));
    }
  },

  addPaneDisposable(subscriptions, pane, eventName, callback) {
    if (typeof pane[eventName] === 'function') {
      subscriptions.add(pane[eventName](callback));
    }
  },

  scheduleSave() {
    if (!this.readyToSave || this.isRestoring) {
      return;
    }

    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
    }

    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.saveOpenTabs();
    }, SAVE_DELAY_MS);
  },

  saveOpenTabs() {
    const savedTabs = this.getOpenTabsSnapshot();
    this.savedTabsFromState = savedTabs;
    atom.config.set(CONFIG_KEY, savedTabs);
    return savedTabs;
  },

  async restoreSavedTabs() {
    if (this.restoreTimer) {
      clearTimeout(this.restoreTimer);
      this.restoreTimer = null;
    }

    const savedTabs = this.getSavedTabs();
    const existingPaths = new Set(
      this.getOpenTabsSnapshot()
        .filter(tab => tab.type === 'file')
        .map(tab => tab.path)
    );
    const existingUntitledEditorsByText = this.getOpenUntitledEditorsByText();
    let activeUntitledEditor = null;

    this.isRestoring = true;

    try {
      for (const tab of savedTabs) {
        if (tab.type === 'untitled') {
          const existingEditor = this.takeExistingUntitledEditor(tab, existingUntitledEditorsByText);
          const editor = existingEditor || await this.openUntitledEditor(tab);

          if (tab.active) {
            activeUntitledEditor = editor;
          }

          continue;
        }

        if (existingPaths.has(tab.path) || !this.pathExists(tab.path)) {
          continue;
        }

        try {
          await atom.workspace.open(tab.path, {
            activateItem: false,
            pending: false,
            searchAllPanes: true
          });

          existingPaths.add(tab.path);
        } catch (error) {
          console.warn(`remember-tabs: Could not restore ${tab.path}`, error);
        }
      }

      const activeTab = savedTabs.find(tab => tab.active);

      if (activeTab && activeTab.type === 'file' && existingPaths.has(activeTab.path)) {
        try {
          await atom.workspace.open(activeTab.path, {
            pending: false,
            searchAllPanes: true
          });
        } catch (error) {
          console.warn(`remember-tabs: Could not activate ${activeTab.path}`, error);
        }
      } else if (activeTab && activeTab.type === 'untitled' && activeUntitledEditor) {
        this.activateItem(activeUntitledEditor);
      }
    } finally {
      this.isRestoring = false;
      this.readyToSave = true;
      this.saveOpenTabs();
    }
  },

  getSavedTabs() {
    const configuredTabs = atom.config.get(CONFIG_KEY);

    if (Array.isArray(configuredTabs)) {
      return this.normalizeTabs(configuredTabs);
    }

    return this.savedTabsFromState;
  },

  async openUntitledEditor(tab) {
    try {
      const editor = await atom.workspace.open();

      if (this.isTextEditor(editor) && typeof editor.setText === 'function') {
        editor.setText(tab.text);
        return editor;
      }
    } catch (error) {
      console.warn('remember-tabs: Could not restore untitled tab', error);
    }

    return null;
  },

  activateItem(item) {
    if (!item) {
      return;
    }

    const pane = atom.workspace.paneForItem(item);

    if (pane && typeof pane.activateItem === 'function') {
      pane.activateItem(item);
    }
  },

  getOpenTabsSnapshot() {
    const tabs = [];
    const seenPaths = new Set();
    const activeItem = atom.workspace.getActivePaneItem();
    const activePath = this.getItemPath(activeItem);

    for (const pane of atom.workspace.getPanes()) {
      for (const item of pane.getItems()) {
        const path = this.getItemPath(item);

        if (path) {
          if (seenPaths.has(path)) {
            continue;
          }

          seenPaths.add(path);
          tabs.push({
            type: 'file',
            path,
            active: path === activePath
          });
          continue;
        }

        if (this.isUntitledTextEditor(item)) {
          const text = item.getText();

          if (this.isRememberableUntitledText(text)) {
            tabs.push({
              type: 'untitled',
              text,
              active: item === activeItem
            });
          }
        }
      }
    }

    return tabs;
  },

  getItemPath(item) {
    if (!item || typeof item.getPath !== 'function') {
      return null;
    }

    const path = this.getRawItemPath(item);
    return this.isRememberablePath(path) ? path : null;
  },

  getRawItemPath(item) {
    if (!item || typeof item.getPath !== 'function') {
      return null;
    }

    const path = item.getPath();
    return typeof path === 'string' && path.length > 0 ? path : null;
  },

  isTextEditor(item) {
    return item && typeof item.getText === 'function';
  },

  isUntitledTextEditor(item) {
    return this.isTextEditor(item) && !this.getRawItemPath(item);
  },

  getOpenUntitledEditorsByText() {
    const editorsByText = new Map();

    for (const pane of atom.workspace.getPanes()) {
      for (const item of pane.getItems()) {
        if (!this.isUntitledTextEditor(item)) {
          continue;
        }

        const text = item.getText();

        if (!this.isRememberableUntitledText(text)) {
          continue;
        }

        if (!editorsByText.has(text)) {
          editorsByText.set(text, []);
        }

        editorsByText.get(text).push(item);
      }
    }

    return editorsByText;
  },

  takeExistingUntitledEditor(tab, editorsByText) {
    const editors = editorsByText.get(tab.text);

    if (!editors || editors.length === 0) {
      return null;
    }

    return editors.shift();
  },

  normalizeTabs(tabs) {
    if (!Array.isArray(tabs)) {
      return [];
    }

    const normalizedTabs = [];
    const seenPaths = new Set();

    for (const tab of tabs) {
      if (tab && tab.type === 'untitled') {
        const text = typeof tab.text === 'string' ? tab.text : '';

        if (!this.isRememberableUntitledText(text)) {
          continue;
        }

        normalizedTabs.push({
          type: 'untitled',
          text,
          active: Boolean(tab.active)
        });
        continue;
      }

      const path = typeof tab === 'string' ? tab : tab && tab.path;

      if (!this.isRememberablePath(path) || seenPaths.has(path)) {
        continue;
      }

      seenPaths.add(path);
      normalizedTabs.push({
        type: 'file',
        path,
        active: Boolean(tab && tab.active)
      });
    }

    return normalizedTabs;
  },

  isRememberablePath(path) {
    if (typeof path !== 'string' || path.length === 0) {
      return false;
    }

    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path)) {
      return false;
    }

    return this.pathExists(path);
  },

  isRememberableUntitledText(text) {
    return typeof text === 'string' && text.length > 0;
  },

  pathExists(path) {
    try {
      return fs.existsSync(path);
    } catch (error) {
      return false;
    }
  }
};
