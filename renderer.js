//renderer.js
// After mainWindow.loadURL('https://m365.cloud.microsoft/chat');
mainWindow.webContents.on('did-finish-load', () => {
  mainWindow.webContents.executeJavaScript(`
    (function() {
      if (window.__copilotCtxInstalled) return;
      window.__copilotCtxInstalled = true;

      window.addEventListener('contextmenu', (evt) => {
        // Compute flags for menu logic
        const t = evt.target;
        const isEditable = !!(t && (t.isContentEditable || ['INPUT','TEXTAREA'].includes(t.tagName)));
        const sel = window.getSelection && window.getSelection();
        const hasSelection = !!sel && String(sel).length > 0;

        // Ask preload to show native context menu
        if (window.contextMenu && typeof window.contextMenu.show === 'function') {
          window.contextMenu.show({ isEditable, hasSelection });
          evt.preventDefault();
        }
      }, { capture: true });
    })();
  `).catch(() => {/* ignore */});
});

