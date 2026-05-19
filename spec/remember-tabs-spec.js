'use babel';

import fs from 'fs';
import os from 'os';
import path from 'path';

const CONFIG_KEY = 'remember-tabs.savedTabs';

describe('RememberTabs', () => {
  let packageMain;
  let tempDir;
  let firstFilePath;
  let secondFilePath;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'remember-tabs-'));
    firstFilePath = path.join(tempDir, 'first.txt');
    secondFilePath = path.join(tempDir, 'second.txt');

    fs.writeFileSync(firstFilePath, 'first');
    fs.writeFileSync(secondFilePath, 'second');

    atom.config.unset(CONFIG_KEY);
    destroyWorkspaceItems();

    waitsForPromise(() => atom.packages.activatePackage('remember-tabs').then(pack => {
      packageMain = pack.mainModule;

      if (packageMain.restoreTimer) {
        clearTimeout(packageMain.restoreTimer);
        packageMain.restoreTimer = null;
      }
    }));
  });

  afterEach(() => {
    atom.packages.deactivatePackage('remember-tabs');
    atom.config.unset(CONFIG_KEY);
    destroyWorkspaceItems();
    removeTempDir(tempDir);
  });

  it('persists open file tab paths', () => {
    waitsForPromise(() => {
      return atom.workspace.open(firstFilePath)
        .then(() => atom.workspace.open(secondFilePath));
    });

    runs(() => {
      packageMain.readyToSave = true;

      const savedTabs = packageMain.saveOpenTabs();
      const savedPaths = savedTabs.map(tab => tab.path);

      expect(savedPaths).toEqual([firstFilePath, secondFilePath]);
      expect(savedTabs[0].type).toBe('file');
      expect(savedTabs[1].type).toBe('file');
      expect(savedTabs[0].active).toBe(false);
      expect(savedTabs[1].active).toBe(true);
      expect(atom.config.get(CONFIG_KEY)).toEqual(savedTabs);
    });
  });

  it('restores saved tabs without a project folder', () => {
    atom.project.setPaths([]);
    atom.config.set(CONFIG_KEY, [
      { path: firstFilePath, active: false },
      { path: secondFilePath, active: true }
    ]);

    waitsForPromise(() => packageMain.restoreSavedTabs());

    runs(() => {
      const openPaths = atom.workspace.getTextEditors().map(editor => editor.getPath());

      expect(openPaths).toContain(firstFilePath);
      expect(openPaths).toContain(secondFilePath);
      expect(atom.workspace.getActiveTextEditor().getPath()).toBe(secondFilePath);
    });
  });

  it('persists untitled editor text', () => {
    waitsForPromise(() => {
      return atom.workspace.open().then(editor => {
        editor.setText('draft notes');
        return atom.workspace.open(firstFilePath);
      });
    });

    runs(() => {
      packageMain.readyToSave = true;

      const savedTabs = packageMain.saveOpenTabs();

      expect(savedTabs).toEqual([
        {
          type: 'untitled',
          text: 'draft notes',
          active: false
        },
        {
          type: 'file',
          path: firstFilePath,
          active: true
        }
      ]);
      expect(atom.config.get(CONFIG_KEY)).toEqual(savedTabs);
    });
  });

  it('restores untitled editor text', () => {
    atom.config.set(CONFIG_KEY, [
      { type: 'untitled', text: 'draft notes', active: true }
    ]);

    waitsForPromise(() => packageMain.restoreSavedTabs());

    runs(() => {
      const untitledEditors = atom.workspace.getTextEditors().filter(editor => !editor.getPath());

      expect(untitledEditors.length).toBe(1);
      expect(untitledEditors[0].getText()).toBe('draft notes');
      expect(atom.workspace.getActiveTextEditor()).toBe(untitledEditors[0]);
    });
  });
});

function destroyWorkspaceItems() {
  for (const pane of atom.workspace.getPanes()) {
    for (const item of pane.getItems().slice()) {
      if (typeof pane.destroyItem === 'function') {
        pane.destroyItem(item);
      } else if (item && typeof item.destroy === 'function') {
        item.destroy();
      }
    }
  }
}

function removeTempDir(dirPath) {
  if (!dirPath) {
    return;
  }

  try {
    for (const entry of fs.readdirSync(dirPath)) {
      fs.unlinkSync(path.join(dirPath, entry));
    }

    fs.rmdirSync(dirPath);
  } catch (error) {}
}
