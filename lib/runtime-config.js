'use strict';

const util = require('util');

function createRuntimeConfig(deps = {}) {
    const {
        app,
        fs,
        path,
        defaultAppConfig,
        partitionEnvVar,
        onConfigLoaded,
    } = deps;

    if (!app || !fs || !path) {
        throw new Error('createRuntimeConfig requires app, fs, and path dependencies.');
    }

    if (!defaultAppConfig || typeof defaultAppConfig !== 'object') {
        throw new Error('createRuntimeConfig requires defaultAppConfig.');
    }

    let APP_CONFIG = { ...defaultAppConfig };

    const ORIGINAL_CONSOLE = Object.freeze({
        log: console.log.bind(console),
        info: console.info.bind(console),
        debug: console.debug.bind(console),
        warn: console.warn.bind(console),
        error: console.error.bind(console),
    });

    let consoleLoggingEnabled = true;
    let fileLoggingEnabled = false;
    let activeLogFilePath = null;
    let isWritingLogFile = false;
    let activeRendererLogFilePath = null;
    let isWritingRendererLogFile = false;

    function sanitizeLogFileName(name) {
        return String(name || defaultAppConfig.logFileName)
            .trim()
            .replace(/[^a-zA-Z0-9._-]/g, '-')
            || defaultAppConfig.logFileName;
    }

    function getConfigFilePath() {
        return path.join(app.getPath('userData'), 'config.json');
    }

    function getLogFilePath() {
        const logsDir = path.join(app.getPath('userData'), 'logs');
        try { fs.mkdirSync(logsDir, { recursive: true }); } catch {}
        return path.join(logsDir, sanitizeLogFileName(APP_CONFIG.logFileName));
    }

    function formatConsoleArg(value) {
        if (typeof value === 'string') return value;
        try {
            return util.inspect(value, {
                depth: 6,
                colors: false,
                breakLength: 160,
            });
        } catch {
            try { return JSON.stringify(value); } catch {}
        }
        return String(value);
    }

    function appendConsoleLogToFile(level, args) {
        if (!fileLoggingEnabled || !activeLogFilePath || isWritingLogFile) return;
        isWritingLogFile = true;
        try {
            const timestamp = new Date().toISOString();
            const rendered = Array.from(args).map(formatConsoleArg).join(' ');
            fs.appendFileSync(activeLogFilePath, `[${timestamp}] [${level}] ${rendered}\n`, 'utf8');
        } catch {
            // Avoid recursive console logging from logging itself.
        } finally {
            isWritingLogFile = false;
        }
    }

    // ---- Renderer console capture -------------------------------------------
    // Renderer-side console.* (renderer/agent.js, preload, and the hosted web
    // app) runs in a different process and never passes through the patched
    // main-process console below, so it previously reached NO log file. These
    // helpers mirror it into a dedicated renderer log file. A separate file is
    // used deliberately: the hosted web app is chatty, and interleaving it with
    // the app's own main-process log would bury the useful lines.
    function getRendererLogFilePath() {
        const logsDir = path.join(app.getPath('userData'), 'logs');
        try { fs.mkdirSync(logsDir, { recursive: true }); } catch {}
        return path.join(
            logsDir,
            sanitizeLogFileName(
                APP_CONFIG.rendererLogFileName || defaultAppConfig.rendererLogFileName
            )
        );
    }

    function appendRendererLogToFile(level, text, meta) {
        if (!fileLoggingEnabled || isWritingRendererLogFile) return;
        const target = activeRendererLogFilePath || getRendererLogFilePath();
        if (!target) return;
        isWritingRendererLogFile = true;
        try {
            const timestamp = new Date().toISOString();
            const where = meta && meta.source
                ? ` (${meta.source}${meta.line ? ':' + meta.line : ''})`
                : '';
            const label = meta && meta.label ? `[${meta.label}] ` : '';
            fs.appendFileSync(
                target,
                `[${timestamp}] [${level}] ${label}${text}${where}\n`,
                'utf8'
            );
        } catch {
            // Never let logging failures break the app.
        } finally {
            isWritingRendererLogFile = false;
        }
    }

    // Normalize Electron's console-message payload. Electron >=30 passes a
    // details object; older versions pass positional args. Support both so this
    // keeps working across upgrades.
    function normalizeConsoleMessageArgs(a, b, c, d) {
        if (a && typeof a === 'object' && ('message' in a || 'level' in a)) {
            const lvl = String(a.level ?? 'info').toUpperCase();
            return {
                level: lvl === 'WARNING' ? 'WARN' : lvl,
                message: String(a.message ?? ''),
                line: a.lineNumber ?? null,
                source: a.sourceId ?? null,
            };
        }
        const levels = ['DEBUG', 'INFO', 'WARN', 'ERROR'];
        return {
            level: levels[Number(a)] || 'INFO',
            message: String(b ?? ''),
            line: c ?? null,
            source: d ?? null,
        };
    }

    // Attach to a webContents so its console output is captured. Safe to call
    // repeatedly; a per-webContents flag prevents duplicate listeners.
    function attachRendererConsoleCapture(webContents, label) {
        if (!webContents || typeof webContents.on !== 'function') return false;
        if (APP_CONFIG.enableRendererConsoleCapture === false) return false;
        try {
            if (webContents.__rendererConsoleCaptureAttached) return false;
            webContents.__rendererConsoleCaptureAttached = true;
        } catch { /* frozen object: fall through and attach anyway */ }

        try {
            webContents.on('console-message', (_event, a, b, c, d) => {
                // Re-read the flag each time so a config reload takes effect.
                if (APP_CONFIG.enableRendererConsoleCapture === false) return;
                const info = normalizeConsoleMessageArgs(a, b, c, d);
                appendRendererLogToFile(info.level, info.message, {
                    source: info.source,
                    line: info.line,
                    label: label || 'renderer',
                });
            });
            return true;
        } catch {
            return false;
        }
    }

    // ---- Verbose diagnostics -------------------------------------------------
    // For large diagnostic dumps: always honors enableFileLogging, but stays off
    // the console unless verboseDiagnosticsToConsole is true. This keeps
    // multi-hundred-line JSON blobs out of the terminal while preserving them in
    // the log file for analysis.
    function logVerbose(...args) {
        if (APP_CONFIG.verboseDiagnosticsToConsole === true) {
            if (consoleLoggingEnabled) ORIGINAL_CONSOLE.log(...args);
        }
        appendConsoleLogToFile('VERBOSE', args);
    }

    function makeConsoleMethod(level) {
        const original = ORIGINAL_CONSOLE[level.toLowerCase()] || ORIGINAL_CONSOLE.log;
        return (...args) => {
            if (consoleLoggingEnabled) original(...args);
            appendConsoleLogToFile(level, args);
        };
    }

    function applyConsoleLoggingConfig() {
        consoleLoggingEnabled = APP_CONFIG.enableConsoleLogging !== false;
        fileLoggingEnabled = APP_CONFIG.enableFileLogging === true;
        activeLogFilePath = fileLoggingEnabled ? getLogFilePath() : null;
        activeRendererLogFilePath = fileLoggingEnabled ? getRendererLogFilePath() : null;

        console.log = makeConsoleMethod('LOG');
        console.info = makeConsoleMethod('INFO');
        console.debug = makeConsoleMethod('DEBUG');
        console.warn = makeConsoleMethod('WARN');
        console.error = makeConsoleMethod('ERROR');
    }

    function normalizeBooleanConfig(value, fallback) {
        if (typeof value === 'boolean') return value;
        if (typeof value === 'string') {
            const lowered = value.trim().toLowerCase();
            if (['true', '1', 'yes', 'on'].includes(lowered)) return true;
            if (['false', '0', 'no', 'off'].includes(lowered)) return false;
        }
        return fallback;
    }

    function normalizePositiveIntegerConfig(value, fallback) {
        const n = Number(value);
        if (Number.isFinite(n) && n >= 0) return Math.round(n);
        return fallback;
    }

    function normalizeExportFormat(value, fallback) {
        const fmt = String(value ?? fallback).trim().toLowerCase().replace(/^\./, '');
        return ['md', 'markdown', 'pdf', 'html', 'mhtml', 'txt'].includes(fmt) ? fmt : fallback;
    }

    function normalizeExportProfile(value, fallback) {
        const profile = String(value ?? fallback).trim();
        return [
            'cleanMarkdown',
            'rawMarkdown',
            'markdownWithMetadata',
            'html',
            'htmlArchive',
            'plainText',
            'pdf',
        ].includes(profile)
            ? profile
            : fallback;
    }

    function normalizeAppConfig(raw = {}) {
        const source = (raw && typeof raw === 'object') ? raw : {};
        const merged = { ...defaultAppConfig, ...source };

        merged.appUrl = String(merged.appUrl || defaultAppConfig.appUrl).trim();
        merged.partition = String(
            process.env[partitionEnvVar] ??
            merged.partition ??
            defaultAppConfig.partition
        ).trim();
        merged.enableLayoutCss = normalizeBooleanConfig(merged.enableLayoutCss, defaultAppConfig.enableLayoutCss);
        merged.enableDirectOpen = normalizeBooleanConfig(merged.enableDirectOpen, defaultAppConfig.enableDirectOpen);
        merged.enableQuickChat = normalizeBooleanConfig(merged.enableQuickChat, defaultAppConfig.enableQuickChat);
        merged.defaultExportFormat = normalizeExportFormat(merged.defaultExportFormat, defaultAppConfig.defaultExportFormat);
        merged.defaultPaneExportProfile = normalizeExportProfile(merged.defaultPaneExportProfile, defaultAppConfig.defaultPaneExportProfile);
        merged.defaultSelectionExportProfile = normalizeExportProfile(merged.defaultSelectionExportProfile, defaultAppConfig.defaultSelectionExportProfile);
        merged.quickPasteDelayMs = normalizePositiveIntegerConfig(merged.quickPasteDelayMs, defaultAppConfig.quickPasteDelayMs);
        merged.findContentVisibilityOverride = normalizeBooleanConfig(merged.findContentVisibilityOverride, defaultAppConfig.findContentVisibilityOverride);
        merged.devToolsEnabled = normalizeBooleanConfig(merged.devToolsEnabled, defaultAppConfig.devToolsEnabled);
        merged.enableExportDiagnostics = normalizeBooleanConfig(merged.enableExportDiagnostics, defaultAppConfig.enableExportDiagnostics);
        merged.enableConsoleLogging = normalizeBooleanConfig(merged.enableConsoleLogging, defaultAppConfig.enableConsoleLogging);
        merged.enableFileLogging = normalizeBooleanConfig(merged.enableFileLogging, defaultAppConfig.enableFileLogging);
        merged.logFileName = sanitizeLogFileName(merged.logFileName || defaultAppConfig.logFileName);
        merged.enableRendererConsoleCapture = normalizeBooleanConfig(merged.enableRendererConsoleCapture, defaultAppConfig.enableRendererConsoleCapture);
        merged.rendererLogFileName = sanitizeLogFileName(merged.rendererLogFileName || defaultAppConfig.rendererLogFileName);
        merged.verboseDiagnosticsToConsole = normalizeBooleanConfig(merged.verboseDiagnosticsToConsole, defaultAppConfig.verboseDiagnosticsToConsole);

        // Export/diagnostic flags added alongside the PDF and markdown export
        // work. These were previously merged straight from config.json without
        // coercion, which made them silently unsettable: config.json is plain
        // JSON with no comments, so a hand-edited "false"/"off"/"no" arrives as
        // a STRING, and every consumer tests these with `!== false`. A string is
        // never === false, so the feature stayed ENABLED even though the file
        // said otherwise -- including the documented escape hatches such as
        // expandReasoningForSnapshot:false and stripDecorativeIcons:false.
        merged.enablePdfChunking = normalizeBooleanConfig(merged.enablePdfChunking, defaultAppConfig.enablePdfChunking);
        merged.pdfChunkPageThreshold = normalizePositiveIntegerConfig(merged.pdfChunkPageThreshold, defaultAppConfig.pdfChunkPageThreshold);
        merged.pdfChunkSize = normalizePositiveIntegerConfig(merged.pdfChunkSize, defaultAppConfig.pdfChunkSize);
        merged.pdfChunkPageHeightPx = normalizePositiveIntegerConfig(merged.pdfChunkPageHeightPx, defaultAppConfig.pdfChunkPageHeightPx);
        merged.enableConversationExportDiagnostic = normalizeBooleanConfig(merged.enableConversationExportDiagnostic, defaultAppConfig.enableConversationExportDiagnostic);
        merged.enableReasoningExpansion = normalizeBooleanConfig(merged.enableReasoningExpansion, defaultAppConfig.enableReasoningExpansion);
        merged.expandReasoningForSnapshot = normalizeBooleanConfig(merged.expandReasoningForSnapshot, defaultAppConfig.expandReasoningForSnapshot);
        merged.reasoningExpandBudgetMs = normalizePositiveIntegerConfig(merged.reasoningExpandBudgetMs, defaultAppConfig.reasoningExpandBudgetMs);
        merged.stripDecorativeIcons = normalizeBooleanConfig(merged.stripDecorativeIcons, defaultAppConfig.stripDecorativeIcons);
        merged.cleanMarkdownStripsJunk = normalizeBooleanConfig(merged.cleanMarkdownStripsJunk, defaultAppConfig.cleanMarkdownStripsJunk);

        if (!merged.appUrl) merged.appUrl = defaultAppConfig.appUrl;
        if (!merged.partition) merged.partition = defaultAppConfig.partition;

        return merged;
    }

    function writeConfigFile(configPath, config) {
        fs.mkdirSync(path.dirname(configPath), { recursive: true });
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
    }

    function loadAppConfig() {
        const configPath = getConfigFilePath();
        let parsed = null;

        try {
            if (fs.existsSync(configPath)) {
                parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            }
        } catch (err) {
            console.error('Failed to read config.json; using defaults:', err);
        }

        APP_CONFIG = normalizeAppConfig(parsed ?? defaultAppConfig);

        if (typeof onConfigLoaded === 'function') {
            onConfigLoaded(APP_CONFIG);
        }

        applyConsoleLoggingConfig();

        try {
            writeConfigFile(configPath, APP_CONFIG);
        } catch (err) {
            console.error('Failed to write config.json:', err);
        }

        return APP_CONFIG;
    }

    function ensureConfigFile() {
        loadAppConfig();
        return getConfigFilePath();
    }

    function getAppConfig() {
        return APP_CONFIG;
    }

    return {
        sanitizeLogFileName,
        getConfigFilePath,
        getLogFilePath,
        getRendererLogFilePath,
        formatConsoleArg,
        appendConsoleLogToFile,
        appendRendererLogToFile,
        attachRendererConsoleCapture,
        logVerbose,
        makeConsoleMethod,
        applyConsoleLoggingConfig,
        normalizeBooleanConfig,
        normalizePositiveIntegerConfig,
        normalizeExportFormat,
        normalizeExportProfile,
        normalizeAppConfig,
        writeConfigFile,
        loadAppConfig,
        ensureConfigFile,
        getAppConfig,
    };
}

module.exports = { createRuntimeConfig };
