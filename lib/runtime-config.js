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
        merged.enableConsoleLogging = normalizeBooleanConfig(merged.enableConsoleLogging, defaultAppConfig.enableConsoleLogging);
        merged.enableFileLogging = normalizeBooleanConfig(merged.enableFileLogging, defaultAppConfig.enableFileLogging);
        merged.logFileName = sanitizeLogFileName(merged.logFileName || defaultAppConfig.logFileName);

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
        formatConsoleArg,
        appendConsoleLogToFile,
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
