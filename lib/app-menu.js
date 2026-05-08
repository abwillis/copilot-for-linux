'use strict';

// === Application menu assembly ===
// Extracted from main.js (Tier 3 refactor).

function createAppMenu(deps = {}) {
  const {
    Menu, MenuItem, BrowserWindow, dialog, shell,
    getAppConfig, getMainWindow,
    openFindModal, initFindInPage, reloadCopilot, clearCopilotCache, clearCookiesAndSignOut,
    copyCurrentUrl, openCurrentUrlExternal, openLogsFolder, openConfigFile,
    toggleActiveWindowAlwaysOnTop, showAboutDialog, showApplicationHelp,
    getRuntimeInfo, appIconImage,
    buildExportProfileMenuTemplate, promptExportWithProfile,
    selectChatPane, promptSaveChatPane, EXPORT_SCOPES,
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

// Build Edit menu as a reusable factory
function appendEditItems(editSubmenu) {
  const template = [
    //    { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
    //    { role: 'cut' }, { role: 'copy' }, { role: 'paste' },
    //    { role: 'selectAll' }, { type: 'separator' },
    ...initFindInPage().buildEditFindMenuItems(),
    { type: 'separator' },
    {
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
  const template = [
    new MenuItem({
      label: 'Application Help',
      accelerator: 'F1',
      click: () => {
        showApplicationHelp();
      }
    }),
    new MenuItem({ type: 'separator' }),
    new MenuItem({
      label: 'About',
      accelerator: 'Shift+F1',
      click: async () => {
        try {
          const info = getRuntimeInfo();
          await dialog.showMessageBox({
            type: 'info',
            buttons: ['OK'],
            defaultId: 0,
              title: `About ${info.name}`,
              message: `${info.name}`,
              detail: info.detail,
              noLink: true,
              icon: appIconImage
          });
        } catch (err) {
          console.error('Help  About dialog failed:', err);
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
  const template = [
    new MenuItem({
      label: 'Reload Copilot',
      accelerator: 'Ctrl+R',
      click: () => reloadCopilot({ ignoreCache: false })
    }),
    new MenuItem({
      label: 'Hard Reload',
      accelerator: 'Ctrl+Shift+R',
      click: () => reloadCopilot({ ignoreCache: true })
    }),
    new MenuItem({ type: 'separator' }),
    new MenuItem({
      label: 'Clear Copilot Cache',
      click: async () => {
        await clearCopilotCache();
      }
    }),
    new MenuItem({
      label: 'Clear Cookies / Sign Out',
      click: async () => {
        await clearCookiesAndSignOut();
      }
    }),
    new MenuItem({
      label: 'Copy Current URL',
      click: () => copyCurrentUrl()
    }),
    new MenuItem({
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
  if (APP_CONFIG.enableQuickChat) installQuickChatMenu(appMenu);
  else Menu.setApplicationMenu(appMenu);
}



// ---------- File menu (Save / Save As) ----------
function appendFileItems(fileSubmenu, win) {
  ensureSaveState(win);
  const items = [
    new MenuItem({ type: 'separator' }),
    new MenuItem({
      label: 'Save Chat Pane',
      accelerator: 'Ctrl+S',
      click: async () => {
        try { await promptSaveChatPane(win); }
        catch (err) {
          console.error('File  Save Chat Pane failed:', err);
          try { dialog.showErrorBox('Save failed', String(err?.message || err)); } catch {}
        }
      }
    }),
    new MenuItem({
      label: 'Export Chat Pane',
      submenu: Menu.buildFromTemplate(buildExportProfileMenuTemplate(win, EXPORT_SCOPES.PANE))
    }),
    new MenuItem({
      label: 'Export Selection',
      submenu: Menu.buildFromTemplate(buildExportProfileMenuTemplate(win, EXPORT_SCOPES.SELECTION))
    }),
    new MenuItem({ type: 'separator' }),
    new MenuItem({
      label: 'Save Selection as Markdown',
      accelerator: 'Ctrl+Shift+M',
      click: async () => {
        try { await saveSelectionAsMarkdown(win); }
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
