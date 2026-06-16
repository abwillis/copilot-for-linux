'use strict';

// === Application menu assembly ===
// Extracted from main.js (Tier 3 refactor).

function createAppMenu(deps = {}) {
  const {
    Menu, MenuItem, BrowserWindow, dialog, shell,
    getAppConfig, getMainWindow,
    appLabel,
    openFindModal, initFindInPage, reloadApp, clearAppCache, clearCookiesAndSignOut,
    copyCurrentUrl, openCurrentUrlExternal, openLogsFolder, openConfigFile,
    toggleActiveWindowAlwaysOnTop, showAboutDialog, showApplicationHelp,
    getRuntimeInfo, appIconImage,
    buildExportProfileMenuTemplate, promptExportWithProfile,
    selectChatPane, promptSaveChatPane, printChatPane, printSelection, saveSelectionAsMarkdown, EXPORT_SCOPES,
    buildQuickChatManagerMenuTemplate, installQuickChatMenu, refreshQuickChatMenu,
    createQuickChatWindow, buildSendToQuickSubmenu, SEND_MODE,
    ensureSaveState,
  } = deps;

  const APP_CONFIG = new Proxy({}, {
    get(_t, p) {
      const c = (typeof getAppConfig === 'function') ? getAppConfig() : {};
      return c ? c[p] : undefined;
    }
  });

// Return true if this submenu already contains a app-managed item.
// This prevents duplicated menu groups if augmentApplicationMenu() is called
// again after an in-process window recreate.
function submenuHasManagedItem(submenu, { id, label } = {}) {
  try {
    if (!submenu) return false;
    if (id && typeof submenu.getMenuItemById === 'function' && submenu.getMenuItemById(id)) return true;
    if (label && Array.isArray(submenu.items) && submenu.items.some(item => item?.label === label)) return true;
  } catch {}
  return false;
}

// Build Edit menu as a reusable factory
function appendEditItems(editSubmenu) {
  const template = [
    //    { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
    //    { role: 'cut' }, { role: 'copy' }, { role: 'paste' },
    //    { role: 'selectAll' }, { type: 'separator' },
    ...initFindInPage().buildEditFindMenuItems(),
    { type: 'separator' },
    {
      id: 'app-edit-select-chat-pane',
      label: 'Select Chat Pane',
      accelerator: 'Ctrl+Shift+A',
      click: async () => {
        const w = BrowserWindow.getFocusedWindow() || getMainWindow();
        if (!w) return;
        try {
          const res = await selectChatPane(w);
          if (!res?.ok) {
            try { dialog.showErrorBox('Select Chat Pane', 'Could not select the chat pane.'); } catch {}
          }
        } catch (err) {
          console.error('Select Chat Pane failed:', err);
          try { dialog.showErrorBox('Select Chat Pane failed', String(err?.message || err)); } catch {}
        }
      }
    },
  ];
  // Merge our items into the existing Edit menu
  Menu.buildFromTemplate(template).items.forEach(i => editSubmenu.append(i));
}

// --- Help menu: add About screen (under the menu bar) ----------------------
function appendHelpItems(helpSubmenu) {
  if (submenuHasManagedItem(helpSubmenu, { id: 'app-help-application-help', label: 'Application Help' })) {
    return;
  }

  const template = [
    new MenuItem({
      id: 'app-help-application-help',
      label: 'Application Help',
      accelerator: 'F1',
      click: () => {
        showApplicationHelp();
      }
    }),
    new MenuItem({ type: 'separator' }),
    new MenuItem({
      id: 'app-help-about',
      label: 'About',
      accelerator: 'Shift+F1',
      click: async () => {
        try {
          await showAboutDialog();
        } catch (err) {
          console.error('Help About dialog failed:', err);
        }
      }
    }),
    new MenuItem({ type: 'separator' }),
    // (Optional) quick links; uncomment/adjust as needed:
    // new MenuItem({
    //   label: 'Documentation',
    //   click: () => shell.openExternal('https://your.docs.url/')
    // }),
    // new MenuItem({
    //   label: 'Report Issue',
    //   click: () => shell.openExternal('https://your.issues.url/')
    // }),
  ];
  template.forEach(i => helpSubmenu.append(i));
}



// --- Session menu: reload/cache/auth/current URL troubleshooting ------------
function appendSessionItems(sessionSubmenu) {
  if (submenuHasManagedItem(sessionSubmenu, { id: 'app-session-reload', label: `Reload ${deps.appLabel || 'App'}` })) {
    return;
  }

  const template = [
    new MenuItem({
      id: 'app-session-reload',
      label: `Reload ${deps.appLabel || 'App'}`,
      accelerator: 'Ctrl+R',
      click: () => reloadApp({ ignoreCache: false })
    }),
    new MenuItem({
      id: 'app-session-hard-reload',
      label: 'Hard Reload',
      accelerator: 'Ctrl+Shift+R',
      click: () => reloadApp({ ignoreCache: true })
    }),
    new MenuItem({ type: 'separator' }),
    new MenuItem({
      id: 'app-session-clear-cache',
      label: `Clear ${deps.appLabel || 'App'} Cache`,
      click: async () => {
        await clearAppCache();
      }
    }),
    new MenuItem({
      id: 'app-session-clear-cookies-sign-out',
      label: 'Clear Cookies / Sign Out',
      click: async () => {
        await clearCookiesAndSignOut();
      }
    }),
    new MenuItem({
      id: 'app-session-copy-current-url',
      label: 'Copy Current URL',
      click: () => copyCurrentUrl()
    }),
    new MenuItem({
      id: 'app-session-open-current-url-external',
      label: 'Open Current URL in External Browser',
      click: async () => {
        await openCurrentUrlExternal();
      }
    })
  ];

  template.forEach(i => sessionSubmenu.append(i));
}

// Augment (mutate) the existing app menu rather than replacing it

function augmentApplicationMenu(win) {
  // Start from the current application menu.
  // NOTE: On Windows/Linux this may be null until first set; handle that.
  const appMenu = Menu.getApplicationMenu() ?? new Menu();

  // Ensure "File" submenu exists, then append our items
  let fileSubmenu = appMenu.items.find(i => i.label === 'File')?.submenu;
  if (!fileSubmenu) {
    fileSubmenu = new Menu();
    appMenu.insert(0, new MenuItem({ label: 'File', submenu: fileSubmenu }));
  }
  appendFileItems(fileSubmenu, win);

  // Ensure "Edit" submenu exists, then append our items
  let editSubmenu = appMenu.items.find(i => i.label === 'Edit')?.submenu;
  if (!editSubmenu) {
    editSubmenu = new Menu();
    appMenu.insert(1, new MenuItem({ label: 'Edit', submenu: editSubmenu }));
  }
  appendEditItems(editSubmenu);

  // Ensure "Session" submenu exists, then append reload/cache/auth items.
  let sessionSubmenu = appMenu.items.find(i => i.label === 'Session')?.submenu;
  if (!sessionSubmenu) {
    sessionSubmenu = new Menu();
    const sessionItem = new MenuItem({ label: 'Session', submenu: sessionSubmenu });
    const helpIndex = appMenu.items.findIndex(i => i.label === 'Help');
    if (helpIndex >= 0) appMenu.insert(helpIndex, sessionItem);
    else appMenu.append(sessionItem);
  }
  appendSessionItems(sessionSubmenu);

  // Ensure "Help" submenu exists, then append our items
  let helpSubmenu = appMenu.items.find(i => i.label === 'Help')?.submenu;
  if (!helpSubmenu) {
    helpSubmenu = new Menu();
    // Place Help at the end for Windows/Linux conventions
    appMenu.append(new MenuItem({ label: 'Help', submenu: helpSubmenu }));
  }
  appendHelpItems(helpSubmenu);

  // installQuickChatMenu() rebuilds and applies the full application menu.
  // Call it last so the rebuilt menu includes File/Edit/Help and is not
  // overwritten by re-applying the pre-rebuild appMenu object.
    Menu.setApplicationMenu(appMenu);
    try {
        if (APP_CONFIG.enableQuickChat && typeof installQuickChatMenu === 'function') {
            installQuickChatMenu(appMenu);
        }
    } catch (err) {
        console.error('installQuickChatMenu failed (menu still applied):', err);
    }
}

// ---------- File menu (Save / Save As) ----------
function appendFileItems(fileSubmenu, win) {
  if (submenuHasManagedItem(fileSubmenu, { id: 'app-file-save-chat-pane', label: 'Save Chat Pane' })) {
    return;
  }

  ensureSaveState(win);
  // Resolve the active window at click time rather than using the captured
  // `win` from menu-build time.  This ensures File menu actions target
  // the focused Quick Chat window (if any) instead of always hitting main.
  const getActiveWin = () => BrowserWindow.getFocusedWindow() || win;
  const items = [
    new MenuItem({ type: 'separator' }),
    new MenuItem({
      id: 'app-file-save-chat-pane',
      label: 'Save Chat Pane',
      accelerator: 'Ctrl+S',
      click: async () => {
        try { await promptSaveChatPane(getActiveWin()); }
        catch (err) {
          console.error('File  Save Chat Pane failed:', err);
          try { dialog.showErrorBox('Save failed', String(err?.message || err)); } catch {}
        }
      }
    }),
    new MenuItem({
      id: 'app-file-print-chat-pane',
      label: 'Print Chat Pane',
      accelerator: 'Ctrl+P',
      click: async () => {
        try { await printChatPane(getActiveWin()); }
        catch (err) {
          console.error('File  Print Chat Pane failed:', err);
          try { dialog.showErrorBox('Print failed', String(err?.message || err)); } catch {}
        }
      }
    }),
    new MenuItem({
      id: 'app-file-print-selection',
      label: 'Print Selection',
      accelerator: 'Ctrl+Shift+P',
      click: async () => {
        try { await printSelection(getActiveWin()); }
        catch (err) {
          console.error('File  Print Selection failed:', err);
          try { dialog.showErrorBox('Print failed', String(err?.message || err)); } catch {}
        }
      }
    }),
    new MenuItem({
      id: 'app-file-export-chat-pane',
      label: 'Export Chat Pane',
      submenu: Menu.buildFromTemplate(buildExportProfileMenuTemplate(getActiveWin, EXPORT_SCOPES.PANE))
    }),
    new MenuItem({
      id: 'app-file-export-selection',
      label: 'Export Selection',
      submenu: Menu.buildFromTemplate(buildExportProfileMenuTemplate(getActiveWin, EXPORT_SCOPES.SELECTION))
    }),
    new MenuItem({ type: 'separator' }),
    new MenuItem({
      id: 'app-file-save-selection-markdown',
      label: 'Save Selection as Markdown',
      accelerator: 'Ctrl+Shift+M',
      click: async () => {
        try { await saveSelectionAsMarkdown(getActiveWin()); }
        catch (err) {
          console.error('File  Save Selection as Markdown failed:', err);
          try { dialog.showErrorBox('Save failed', String(err?.message || err)); } catch {}
        }
      }
    }),

    //    new MenuItem({ type: 'separator' }),
    // Use role for native Quit (macOS label/shortcut handled automatically)
    //    new MenuItem({ role: 'quit' }),
  ];
  items.forEach(i => fileSubmenu.append(i));
}

// ---------- end File menu ----------


  return {
    appendEditItems, appendHelpItems, appendSessionItems,
    augmentApplicationMenu, appendFileItems,
  };
}

module.exports = { createAppMenu };
