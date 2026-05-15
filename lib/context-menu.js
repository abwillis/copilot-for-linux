'use strict';

// === Right-click context menu template builder ===
// Extracted from main.js (Tier 3 refactor).

function createContextMenu(deps = {}) {
  const {
    Menu, MenuItem, clipboard, shell, BrowserWindow, dialog, ipcMain,
    getAppConfig, SEND_MODE, EXPORT_SCOPES,
    selectChatPane, promptSaveChatPane, getSelectionFragment,
    htmlToMarkdown, buildSendToQuickSubmenu, createQuickChatWindow,
    promptExportWithProfile, buildExportProfileMenuTemplate,
    openFindModal, reveal, safeShowError, saveSelectionAsMarkdown,
  } = deps;

  const APP_CONFIG = new Proxy({}, {
    get(_t, p) {
      const c = (typeof getAppConfig === 'function') ? getAppConfig() : {};
      return c ? c[p] : undefined;
    }
  });

function buildContextMenuTemplate(win, params, options = {}) {
  const {
    includeQuickChatFeatures = true,
    includeChatPaneFeatures = true,
    includeMarkdownExport = true
  } = options;

  const isEditable = !!params?.isEditable;
  const hasSelection = !!params?.selectionText && params.selectionText.length > 0;

  const inspectItem = {
    label: 'Inspect Element',
    accelerator: 'Ctrl+Shift+C',
    click: () => {
      try {
        win.webContents.inspectElement(params.x, params.y);
        if (!win.webContents.isDevToolsOpened()) {
          win.webContents.openDevTools({ mode: 'right' });
        }
      } catch (err) {
        console.error('Inspect failed:', err);
      }
    }
  };

  const template = [
    { role: 'cut', accelerator: 'Ctrl+X', enabled: isEditable },
    { role: 'copy', accelerator: 'Ctrl+C', enabled: (hasSelection || isEditable) },
    { role: 'paste', accelerator: 'Ctrl+V', enabled: isEditable },
    { type: 'separator' },
    { role: 'selectAll', accelerator: 'Ctrl+A', enabled: true }
  ];

  if (includeQuickChatFeatures) {
    template.push(
      { type: 'separator' },
      {
        label: 'Send to Quick Chat',
        submenu: buildSendToQuickSubmenu(win, { mode: SEND_MODE.PLAIN, autoSubmit: false })
      },
      {
        label: 'Send as Quote to Quick Chat',
        submenu: buildSendToQuickSubmenu(win, { mode: SEND_MODE.QUOTE, autoSubmit: false })
      },
      {
        label: 'Send & Auto Submit to Quick Chat',
        submenu: buildSendToQuickSubmenu(win, { mode: SEND_MODE.PLAIN, autoSubmit: true })
      },
      { type: 'separator' },
      {
        label: 'New Quick Chat Window',
        accelerator: 'Ctrl+Alt+N',
        click: () => {
          try { reveal(createQuickChatWindow()); }
          catch (e) { console.error('New Quick Chat (context) failed:', e); }
        }
      }
    );
  }

  if (includeChatPaneFeatures) {
    template.push(
      { type: 'separator' },
      {
        label: 'Select Chat Pane',
        accelerator: 'Ctrl+Shift+A',
        enabled: true,
        click: async () => {
          try {
            const res = await selectChatPane(win);
            if (!res?.ok) safeShowError('Select Chat Pane', 'Could not select the chat pane.');
          } catch (err) {
            console.error('Select Chat Pane failed:', err);
            safeShowError('Select Chat Pane failed', String(err?.message ?? err));
          }
        }
      },
      {
        label: 'Save Chat Pane',
        click: async () => {
          await promptSaveChatPane(win);
        }
      }
    );
  }

  if (includeMarkdownExport) {
    template.push(
      { type: 'separator' },
      {
        label: 'Copy Selection as Markdown',
        accelerator: 'Ctrl+Shift+M',
        enabled: hasSelection,
        click: async () => {
          try {
            const { hasSelection: ok, html, text } = await getSelectionFragment(win);
            if (!ok) return;
            const md = htmlToMarkdown(html || text);
            clipboard.writeText(md);
          } catch (err) {
            console.error('Copy Selection as Markdown failed:', err);
          }
        }
      },
      {
        label: 'Save Selection as Markdown',
        enabled: hasSelection,
        click: async () => {
          await saveSelectionAsMarkdown(win);
        }
      },
      {
        label: 'Save Selection As',
        enabled: hasSelection,
        submenu: Menu.buildFromTemplate(buildExportProfileMenuTemplate(win, EXPORT_SCOPES.SELECTION))
      },
      {
        label: 'Save Selection as Plain Text',
        enabled: hasSelection,
        click: async () => {
        await promptExportWithProfile(win, EXPORT_SCOPES.SELECTION, 'plainText');
        }
      }
    );
  }

  template.push({ type: 'separator' }, inspectItem);
  return template;
}



  function registerShowContextMenuIpcHandler(channel = 'show-context-menu') {
    if (!ipcMain || !BrowserWindow) return;
    if (ipcMain.listenerCount(channel)) return;

    ipcMain.on(channel, (event, params) => {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win) return;

      const menu = Menu.buildFromTemplate(
        buildContextMenuTemplate(win, {
          ...params,
          selectionText: params?.selectionText ?? (params?.hasSelection ? 'x' : '')
        }, {
          includeQuickChatFeatures: false,
          includeChatPaneFeatures: false,
          includeMarkdownExport: false
        })
      );
      menu.popup({ window: win });
    });
  }

  return { buildContextMenuTemplate, registerShowContextMenuIpcHandler };
}

module.exports = { createContextMenu };
