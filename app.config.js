'use strict';

const defaultAppConfig = Object.freeze({
  appUrl: 'https://m365.cloud.microsoft/chat',
  partition: String(process.env.COPILOT_PARTITION ?? 'persist:copilot-for-linux').trim(),
  enableLayoutCss: true,
  enableDirectOpen: true,
  enableQuickChat: true,
  defaultExportFormat: 'md',
  defaultPaneExportProfile: 'cleanMarkdown',
  defaultSelectionExportProfile: 'cleanMarkdown',
  quickPasteDelayMs: 3000,
  findContentVisibilityOverride: true,
  devToolsEnabled: true,
  enableConsoleLogging: true,
  enableFileLogging: true,
  logFileName: 'copilot-for-linux.log',
});

module.exports = Object.freeze({
  appLabel: 'Copilot',
  appSlug: 'copilot',
  appName: 'copilot-for-linux',
  appUserModelId: 'your.company.copilot',
  iconFileName: 'copilot-for-linux.png',
  trayToolTip: 'Microsoft Copilot',
  partitionEnvVar: 'COPILOT_PARTITION',
  layoutObserverGlobal: '__copilot_layoutObserver',
  rendererApiGlobal: '__copilotRenderer',
  rendererAgentVersion: 1,

  dynamicWidth: Object.freeze({
    cssVar: '--copilot-vw',
    minVw: 70,
    maxVw: 100,
    defaultVw: 100,
    screenPercent: 95,
  }),

  defaultAppConfig,
});

