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
    const existingPaths = new Set(this.getOpenTabsSnapshot().map(tab => tab.path));

    this.isRestoring = true;

    try {
      for (const tab of savedTabs) {
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

      const activeTab = savedTabs.find(tab => tab.active && existingPaths.has(tab.path));

      if (activeTab) {
        try {
          await atom.workspace.open(activeTab.path, {
            pending: false,
            searchAllPanes: true
          });
        } catch (error) {
          console.warn(`remember-tabs: Could not activate ${activeTab.path}`, error);
        }
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

  getOpenTabsSnapshot() {
    const tabs = [];
    const seenPaths = new Set();
    const activePath = this.getItemPath(atom.workspace.getActivePaneItem());

    for (const pane of atom.workspace.getPanes()) {
      for (const item of pane.getItems()) {
        const path = this.getItemPath(item);

        if (!path || seenPaths.has(path)) {
          continue;
        }

        seenPaths.add(path);
        tabs.push({
          path,
          active: path === activePath
        });
      }
    }

    return tabs;
  },

  getItemPath(item) {
    if (!item || typeof item.getPath !== 'function') {
      return null;
    }

    const path = item.getPath();
    return this.isRememberablePath(path) ? path : null;
  },

  normalizeTabs(tabs) {
    if (!Array.isArray(tabs)) {
      return [];
    }

    const normalizedTabs = [];
    const seenPaths = new Set();

    for (const tab of tabs) {
      const path = typeof tab === 'string' ? tab : tab && tab.path;

      if (!this.isRememberablePath(path) || seenPaths.has(path)) {
        continue;
      }

      seenPaths.add(path);
      normalizedTabs.push({
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

  pathExists(path) {
    try {
      return fs.existsSync(path);
    } catch (error) {
      return false;
    }
  }
};
