'use strict';

const { app, BrowserWindow, ipcMain, shell, screen, Menu, dialog, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');
const ini = require('ini');
const { DropCopyClient, ConfigLoader } = require('./dropcopy-client');
const { BseDropCopyClient } = require('./bse-dropcopy-client');
const ownsSingleInstance = app.requestSingleInstanceLock();

let mainWindow = null;
let client = null;
let bseClient = null;
let activeExchange = 'NSE';
let logsMenuItem = null;
const statsIntervals = { NSE: null, BSE: null };
const exchangeStats = {
    NSEFO: { runtime: 0, tradesReceived: 0, tradesWritten: 0, heartbeatsSent: 0, dataReceived: 0, streamCount: 0 },
    BSEFO: { runtime: 0, tradesReceived: 0, tradesWritten: 0, heartbeatsSent: 0, dataReceived: 0, streamCount: 0 }
};

const USER_DATA = app.getPath('userData');
const INSTALL_DIR = app.isPackaged ? path.dirname(process.execPath) : __dirname;
const SETTING_DIR = path.join(INSTALL_DIR, 'setting');
const CONFIG_PATH = path.join(SETTING_DIR, 'nse_config.ini');
const BSE_CONFIG_PATH = path.join(SETTING_DIR, 'bse_config.ini');
const APP_SETTINGS_PATH = path.join(SETTING_DIR, 'app-settings.json');
let BUILD_ID = 'development';
try {
    const buildInfo = JSON.parse(fs.readFileSync(path.join(__dirname, 'build-info.json'), 'utf8'));
    if (buildInfo && typeof buildInfo.buildId === 'string') BUILD_ID = buildInfo.buildId;
} catch (_) {}
const COMPANY_NAME_PATH = path.join(USER_DATA, 'company-name.enc');
const COMPANY_REGISTRY_KEY = 'HKCU\\Software\\Sanjay\\NSE BSE DropCopy Client';
const LOG_DIR = path.join(INSTALL_DIR, 'log');
const CONTRACT_DIR = path.join(INSTALL_DIR, 'contract');
const CONTRACT_SOURCE_DIR = app.isPackaged ? path.join(process.resourcesPath, 'contract') : path.join(__dirname, 'bse_contract');
const BSE_SOURCE_HOME = 'D:\\Cording\\bse_dropcopy_PY';
const DEFAULT_CSV_OUTPUT_DIR = path.join(INSTALL_DIR, 'Trade_File');
let CSV_OUTPUT_DIR = DEFAULT_CSV_OUTPUT_DIR;
let CSV_BACKUP_DIR = path.join(INSTALL_DIR, 'Backup');
let appSettings = { csvOutputDir: CSV_OUTPUT_DIR, csvBackupDir: CSV_BACKUP_DIR };

function saveAppSettings() {
    fs.writeFileSync(APP_SETTINGS_PATH, JSON.stringify(appSettings, null, 2) + '\n', 'utf8');
}

const CONFIG_ENCRYPTED_PREFIX = 'ENC1:';
const COMPANY_ENCRYPTED_PREFIX = 'COMPANY1:';
const DEFAULT_COMPANY_NAME = 'ABC Securities Pvt Ltd';

function readInstallerCompanyName() {
    const result = spawnSync('reg.exe', ['query', COMPANY_REGISTRY_KEY, '/v', 'CompanyName'], { encoding: 'utf8', windowsHide: true });
    if (result.status !== 0) return '';
    const match = String(result.stdout || '').match(/CompanyName\s+REG_SZ\s+([^\r\n]*)/i);
    return match ? match[1].trim() : '';
}

function clearInstallerCompanyName() {
    spawnSync('reg.exe', ['delete', COMPANY_REGISTRY_KEY, '/v', 'CompanyName', '/f'], { encoding: 'utf8', windowsHide: true });
}

function writeCompanyName(name) {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('Windows secure storage is unavailable; company name was not saved.');
    const encrypted = safeStorage.encryptString(String(name).trim()).toString('base64');
    fs.mkdirSync(USER_DATA, { recursive: true });
    fs.writeFileSync(COMPANY_NAME_PATH, COMPANY_ENCRYPTED_PREFIX + encrypted, 'utf8');
}

function readCompanyName() {
    if (!fs.existsSync(COMPANY_NAME_PATH)) return '';
    const stored = fs.readFileSync(COMPANY_NAME_PATH, 'utf8');
    if (!stored.startsWith(COMPANY_ENCRYPTED_PREFIX) || !safeStorage.isEncryptionAvailable()) return '';
    return safeStorage.decryptString(Buffer.from(stored.slice(COMPANY_ENCRYPTED_PREFIX.length), 'base64')).trim();
}

function initializeCompanyName(legacyName = '') {
    const installerName = readInstallerCompanyName();
    if (installerName) writeCompanyName(installerName);
    else if (!fs.existsSync(COMPANY_NAME_PATH)) writeCompanyName(legacyName || DEFAULT_COMPANY_NAME);
    if (installerName) clearInstallerCompanyName();
}

function writeConfigFile(configPath, content) {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('Windows secure storage is unavailable; exchange settings were not saved.');
    const encrypted = safeStorage.encryptString(String(content)).toString('base64');
    fs.writeFileSync(configPath, CONFIG_ENCRYPTED_PREFIX + encrypted, 'utf8');
}
function readConfigFile(configPath) {
    const stored = fs.readFileSync(configPath, 'utf8');
    if (stored.startsWith(CONFIG_ENCRYPTED_PREFIX)) {
        if (!safeStorage.isEncryptionAvailable()) throw new Error('Windows secure storage is unavailable; exchange settings cannot be read.');
        const encrypted = Buffer.from(stored.slice(CONFIG_ENCRYPTED_PREFIX.length), 'base64');
        return safeStorage.decryptString(encrypted);
    }
    // Upgrade an older plain INI file to Windows-protected storage on first read.
    writeConfigFile(configPath, stored);
    return stored;
}
function loadNseConfig() {
    ensureConfig();
    ensureNseOutputConfig();
    return new ConfigLoader(CONFIG_PATH).parseConfig(ini.parse(readConfigFile(CONFIG_PATH)));
}

function datedLogBase() {
    return path.join(LOG_DIR, 'dropcopy.log');
}

function initializeAppSettings() {
    fs.mkdirSync(SETTING_DIR, { recursive: true });
    if (!fs.existsSync(CONFIG_PATH)) {
        for (const legacyPath of [path.join(SETTING_DIR, 'config.ini'), path.join(USER_DATA, 'config.ini')]) {
            if (fs.existsSync(legacyPath)) { fs.copyFileSync(legacyPath, CONFIG_PATH); break; }
        }
    }
    if (!fs.existsSync(BSE_CONFIG_PATH)) {
        for (const legacyPath of [path.join(SETTING_DIR, 'dropcopy_config.ini'), path.join(USER_DATA, 'dropcopy_config.ini'), path.join(USER_DATA, 'bse', 'dropcopy_config.ini'), path.join(BSE_SOURCE_HOME, 'dropcopy_config.ini')]) {
            if (fs.existsSync(legacyPath)) { fs.copyFileSync(legacyPath, BSE_CONFIG_PATH); break; }
        }
    }
    // Protect obsolete local config names too, so copied legacy credentials
    // are not left readable as plain text beside the current config files.
    for (const legacyPath of [path.join(SETTING_DIR, 'config.ini'), path.join(SETTING_DIR, 'dropcopy_config.ini')]) {
        if (fs.existsSync(legacyPath)) readConfigFile(legacyPath);
    }

    if (fs.existsSync(APP_SETTINGS_PATH)) {
        try {
            const saved = JSON.parse(fs.readFileSync(APP_SETTINGS_PATH, 'utf8'));
            const oldDefaultBackup = path.resolve(SETTING_DIR, 'Backup');
            const savedOutput = typeof saved.csvOutputDir === 'string' && saved.csvOutputDir ? path.resolve(saved.csvOutputDir) : '';
            const oldDefaultOutputs = [path.resolve(SETTING_DIR, 'CSV_Output'), path.resolve(USER_DATA, 'output')];
            const savedBackup = typeof saved.csvBackupDir === 'string' && saved.csvBackupDir ? path.resolve(saved.csvBackupDir) : '';
            appSettings = {
                csvOutputDir: !savedOutput || oldDefaultOutputs.includes(savedOutput) ? DEFAULT_CSV_OUTPUT_DIR : saved.csvOutputDir,
                csvBackupDir: !savedBackup || savedBackup === oldDefaultBackup ? CSV_BACKUP_DIR : saved.csvBackupDir
            };
        } catch (e) { console.error('[main] Could not read app-settings.json:', e.message); }
    } else {
        appSettings.csvBackupDir = path.join(INSTALL_DIR, 'Backup');
        saveAppSettings();
    }
    CSV_OUTPUT_DIR = path.resolve(appSettings.csvOutputDir);
    CSV_BACKUP_DIR = path.resolve(appSettings.csvBackupDir);
    appSettings.csvOutputDir = CSV_OUTPUT_DIR;
    appSettings.csvBackupDir = CSV_BACKUP_DIR;
    saveAppSettings();
    fs.mkdirSync(CSV_OUTPUT_DIR, { recursive: true });
    fs.mkdirSync(CSV_BACKUP_DIR, { recursive: true });
    fs.mkdirSync(LOG_DIR, { recursive: true });
    ensureContractFiles();

    // Preserve log history from the previous settings\logs and install\logs locations.
    for (const legacyLogDir of [path.join(SETTING_DIR, 'logs'), path.join(INSTALL_DIR, 'logs')]) {
        if (path.resolve(legacyLogDir).toLowerCase() === path.resolve(LOG_DIR).toLowerCase() || !fs.existsSync(legacyLogDir)) continue;
        for (const name of fs.readdirSync(legacyLogDir)) {
            const source = path.join(legacyLogDir, name);
            const target = path.join(LOG_DIR, name);
            if (fs.statSync(source).isFile() && !fs.existsSync(target)) fs.copyFileSync(source, target);
        }
    }

    // Preserve CSVs from the previous app-managed default output folders.
    if (CSV_OUTPUT_DIR === path.resolve(DEFAULT_CSV_OUTPUT_DIR)) {
        for (const oldDir of [path.join(SETTING_DIR, 'CSV_Output'), path.join(USER_DATA, 'output')]) {
            if (!fs.existsSync(oldDir)) continue;
            for (const name of fs.readdirSync(oldDir).filter(name => name.toLowerCase().endsWith('.csv'))) {
                const source = path.join(oldDir, name);
                const target = path.join(CSV_OUTPUT_DIR, name);
                if (fs.statSync(source).isFile() && !fs.existsSync(target)) fs.copyFileSync(source, target);
            }
        }
    }

    // Preserve legacy BSE CSVs in the selected output directory.
    for (const name of ['trades_dropcopy.csv', 'BSE_trades.csv']) {
        const target = path.join(CSV_OUTPUT_DIR, name);
        if (fs.existsSync(target)) continue;
        for (const oldPath of [path.join(USER_DATA, name), path.join(USER_DATA, 'bse', name), path.join(USER_DATA, 'output', name)]) {
            if (fs.existsSync(oldPath)) { fs.copyFileSync(oldPath, target); break; }
        }
    }
}

function ensureDirs() {
    [SETTING_DIR, CSV_OUTPUT_DIR, CSV_BACKUP_DIR, LOG_DIR, CONTRACT_DIR].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });
    ensureContractFiles();
}

function ensureContractFiles() {
    fs.mkdirSync(CONTRACT_DIR, { recursive: true });
    const names = ['gw-ca-cert.pem', 'BSE_EQD_CONTRACT.csv', 'BSE_EQ_SCRIP.csv'];
    const oldDirs = [path.join(INSTALL_DIR, 'bse_contract'), path.join(process.resourcesPath || INSTALL_DIR, 'bse_contract')];
    for (const name of names) {
        const target = path.join(CONTRACT_DIR, name);
        if (fs.existsSync(target)) continue;
        const sources = [path.join(CONTRACT_SOURCE_DIR, name), ...oldDirs.map(dir => path.join(dir, name))];
        const source = sources.find(candidate => path.resolve(candidate).toLowerCase() !== path.resolve(target).toLowerCase() && fs.existsSync(candidate));
        if (source) fs.copyFileSync(source, target);
    }
}

function getNseCsvPath() {
    const config = loadNseConfig();
    const filename = config.csv_output && config.csv_output.filename || 'trades.csv';
    return path.join(CSV_OUTPUT_DIR, filename);
}

function ensureNseOutputConfig() {
    if (!fs.existsSync(CONFIG_PATH)) return;
    const lines = readConfigFile(CONFIG_PATH).split(/\r?\n/);
    let inCsvOutput = false;
    let updatedOutputDir = false;
    const updated = lines.map(line => {
        const section = line.match(/^\s*\[([^\]]+)\]/);
        if (section) inCsvOutput = section[1].toLowerCase() === 'csv_output';
        if (!inCsvOutput) return line;
        const key = line.match(/^\s*([^=\s]+)\s*=/);
        if (!key || key[1].toLowerCase() !== 'output_dir') return line;
        updatedOutputDir = true;
        return `output_dir=${CSV_OUTPUT_DIR}`;
    });
    if (!updatedOutputDir) updated.push('', '[csv_output]', `output_dir=${CSV_OUTPUT_DIR}`);
    writeConfigFile(CONFIG_PATH, updated.join('\n'));
}

function backupAndClearTradeCsvs() {
    try {
        const nseConfig = loadNseConfig();
        const bsePaths = getBseCsvPaths();
        const nseFilename = nseConfig.csv_output && nseConfig.csv_output.filename || 'trades.csv';
        const files = [
            { exchange: 'NSEFO', path: path.join(CSV_OUTPUT_DIR, nseFilename) },
            { exchange: 'BSEFO', path: bsePaths.outputCsv },
            { exchange: 'BSEFO', path: bsePaths.customCsv }
        ].filter(file => fs.existsSync(file.path));
        if (!files.length) {
            console.log('[main] No existing trade CSV files to back up or clear.');
            return;
        }

        const now = new Date();
        const timestamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}_${String(now.getHours()).padStart(2, '0')}-${String(now.getMinutes()).padStart(2, '0')}-${String(now.getSeconds()).padStart(2, '0')}-${String(now.getMilliseconds()).padStart(3, '0')}`;
        const backupDir = path.join(CSV_BACKUP_DIR, timestamp);
        fs.mkdirSync(backupDir, { recursive: true });

        // Complete every backup before clearing any CSV, so a failed copy
        // always leaves the original trade files intact.
        let backedUp;
        try {
            backedUp = files.map(file => {
                const exchangeDir = path.join(backupDir, file.exchange);
                fs.mkdirSync(exchangeDir, { recursive: true });
                const backupPath = path.join(exchangeDir, path.basename(file.path));
                fs.copyFileSync(file.path, backupPath);
                return { ...file, backupPath };
            });
        } catch (e) {
            console.error('[main] Trade CSV backup failed; no CSV files were cleared:', e.message);
            return;
        }

        try {
            for (const file of backedUp) {
                const content = fs.readFileSync(file.path);
                const newline = content.indexOf(0x0a);
                const header = newline >= 0
                    ? content.subarray(0, newline + 1)
                    : (content.length ? Buffer.concat([content, Buffer.from('\r\n')]) : content);
                fs.writeFileSync(file.path, header);
            }
        } catch (e) {
            console.error(`[main] CSV clearing was incomplete; full backups are available at ${backupDir}:`, e.message);
            return;
        }
        console.log(`[main] Backed up and cleared ${backedUp.length} trade CSV file(s): ${backupDir}`);
    } catch (e) {
        console.error('[main] Could not back up and clear trade CSVs:', e.message);
    }
}

function ensureBseFiles() {
    ensureContractFiles();
    const certPath = path.join(INSTALL_DIR, 'gw-ca-cert.pem');
    if (!fs.existsSync(certPath) && fs.existsSync(path.join(CONTRACT_DIR, 'gw-ca-cert.pem'))) {
        fs.copyFileSync(path.join(CONTRACT_DIR, 'gw-ca-cert.pem'), certPath);
    }
    const configPath = BSE_CONFIG_PATH;
    if (!fs.existsSync(configPath)) {
        writeConfigFile(configPath, [
            '[DROPCOPY]', 'cg_host = YOUR_BSE_GATEWAY_HOST', 'cg_port = 0',
            'member_id = 0', 'session_id = 0', 'user_id = 0', 'password =',
            'ref_appl_id = 1', 'partition_whitelist = 0xFFFFFFFF', 'priority_sessions =',
            '', '[FILES]', `ca_cert = ${certPath}`, `output_csv = ${path.join(CSV_OUTPUT_DIR, 'trades_dropcopy.csv')}`,
            `custom_csv = ${path.join(DEFAULT_CSV_OUTPUT_DIR, 'BSE_trades.csv')}`, `log_file = ${datedLogBase()}`,
            `eqd_contract = ${path.join(CONTRACT_DIR, 'BSE_EQD_CONTRACT.csv')}`, `eq_scrip = ${path.join(CONTRACT_DIR, 'BSE_EQ_SCRIP.csv')}`,
            '', '[SESSION]', 'heartbeat_sec = 60', 'iface_version = 2.4',
            '', '[TIMING]', 'response_timeout_sec = 20', 'retransmit_timeout_sec = 5',
            'heartbeat_margin = 0.9', 'retransmit_pause = 0',
            '', '[OUTPUT]', 'mode = append', 'delimiter = comma', 'verbose = true',
            '', '[RETRANSMIT]', 'enabled = false', 'begin_seq = 1',
            'end_seq = 0', 'partition_range = 1-16', ''
        ].join('\n'), 'utf8');
    }
    const config = ini.parse(readConfigFile(configPath));
    const files = config.FILES || (config.FILES = {});
    const resolveFile = value => path.isAbsolute(String(value || '')) ? String(value) : path.resolve(SETTING_DIR, String(value || ''));
    const defaultIfMissing = (key, fallback, requireExisting) => {
        const configured = String(files[key] || '').trim();
        if (!configured || (requireExisting && !fs.existsSync(resolveFile(configured)))) files[key] = fallback;
    };
    const moveLegacyDefault = (key, fallback, oldDirectories) => {
        const configured = String(files[key] || '').trim();
        if (!configured) { files[key] = fallback; return; }
        const resolved = path.resolve(resolveFile(configured)).toLowerCase();
        const isLegacyDefault = oldDirectories.some(dir => path.dirname(resolved) === path.resolve(dir).toLowerCase());
        if (isLegacyDefault) files[key] = fallback;
    };
    const defaultBseCustomCsv = path.join(DEFAULT_CSV_OUTPUT_DIR, 'BSE_trades.csv');
    // The primary BSE CSV stays in the shared output folder and is intentionally
    // hidden from the editable form. Other FILES paths remain user-configurable.
    files.output_csv = path.join(CSV_OUTPUT_DIR, 'trades_dropcopy.csv');
    const legacyContractDirs = [path.join(INSTALL_DIR, 'bse_contract'), path.join(process.resourcesPath || INSTALL_DIR, 'bse_contract'), path.join(SETTING_DIR, 'bse_contract'), path.join(__dirname, 'bse_contract')];
    moveLegacyDefault('ca_cert', certPath, [...legacyContractDirs, SETTING_DIR]);
    defaultIfMissing('ca_cert', certPath, true);
    moveLegacyDefault('custom_csv', defaultBseCustomCsv, [
        path.join(INSTALL_DIR, 'CSV_Output'), path.join(SETTING_DIR, 'CSV_Output'),
        SETTING_DIR, USER_DATA, path.join(USER_DATA, 'bse'), path.join(USER_DATA, 'output')
    ]);
    defaultIfMissing('custom_csv', defaultBseCustomCsv, false);
    moveLegacyDefault('log_file', datedLogBase(), [path.join(INSTALL_DIR, 'logs'), path.join(SETTING_DIR, 'logs')]);
    files.log_file = datedLogBase();
    moveLegacyDefault('eqd_contract', path.join(CONTRACT_DIR, 'BSE_EQD_CONTRACT.csv'), legacyContractDirs);
    moveLegacyDefault('eq_scrip', path.join(CONTRACT_DIR, 'BSE_EQ_SCRIP.csv'), legacyContractDirs);
    defaultIfMissing('eqd_contract', path.join(CONTRACT_DIR, 'BSE_EQD_CONTRACT.csv'), true);
    defaultIfMissing('eq_scrip', path.join(CONTRACT_DIR, 'BSE_EQ_SCRIP.csv'), true);
    config.FILES = files;
    writeConfigFile(configPath, ini.stringify(config));
    return configPath;
}

function getBseCsvPaths() {
    const parsed = ini.parse(readConfigFile(ensureBseFiles()));
    const files = parsed.FILES || {};
    const resolveFile = (value, fallback) => {
        const configured = String(value || fallback || '');
        return path.isAbsolute(configured) ? configured : path.resolve(SETTING_DIR, configured);
    };
    return {
        outputCsv: resolveFile(files.output_csv, path.join(CSV_OUTPUT_DIR, 'trades_dropcopy.csv')),
        customCsv: resolveFile(files.custom_csv, path.join(DEFAULT_CSV_OUTPUT_DIR, 'BSE_trades.csv'))
    };
}

function parseCsvLine(line) {
    const out = []; let value = ''; let quoted = false;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (quoted) {
            if (ch === '"' && line[i + 1] === '"') { value += '"'; i++; }
            else if (ch === '"') quoted = false;
            else value += ch;
        } else if (ch === '"') quoted = true;
        else if (ch === ',') { out.push(value); value = ''; }
        else value += ch;
    }
    out.push(value); return out;
}

function readCsvRows(csvPath) {
    if (!fs.existsSync(csvPath)) return [];
    const lines = fs.readFileSync(csvPath, 'utf8').trim().split(/\r?\n/);
    if (lines.length < 2) return [];
    const headers = parseCsvLine(lines[0]);
    return lines.slice(1).filter(line => line.trim()).map(line => {
        const values = parseCsvLine(line); const row = {};
        headers.forEach((header, i) => { row[header] = values[i] || ''; });
        return row;
    });
}

function startBse() {
    const configPath = ensureBseFiles();
    const bseConfig = ini.parse(readConfigFile(configPath));
    if (!bseConfig.DROPCOPY || !bseConfig.DROPCOPY.cg_host || bseConfig.DROPCOPY.cg_host.includes('YOUR_') || Number(bseConfig.DROPCOPY.cg_port) <= 0) {
        throw new Error(`Complete the BSE connection settings in ${configPath} before starting.`);
    }
    activeExchange = 'BSE';
    bseClient = new BseDropCopyClient({ config: bseConfig, home: SETTING_DIR });
    bseClient.on('status', d => send('client:status', { ...d, exchange: 'BSEFO' }));
    bseClient.on('trade', d => send('client:trade', { ...d, exchange: 'BSEFO' }));
    bseClient.on('heartbeat', d => send('client:heartbeat', d));
    bseClient.on('stats', d => publishStats('BSE', d));
    bseClient.on('log', d => send('client:log', d));
    bseClient.on('error', err => send('client:log', { level: 'ERROR', message: err.message }));
    const runningClient = bseClient;
    runningClient.runPromise = runningClient.run();
    runningClient.runPromise.finally(() => {
        if (bseClient === runningClient) {
            bseClient = null;
            if (statsIntervals.BSE) clearInterval(statsIntervals.BSE);
            statsIntervals.BSE = null;
            publishStats('BSE', runningClient.getStats());
        }
    });
    statsIntervals.BSE = setInterval(() => { if (bseClient) publishStats('BSE', bseClient.getStats()); }, 250);
}

function ensureConfig() {
    // 1. Create the config file if missing
    if (!fs.existsSync(CONFIG_PATH)) {
        const bundled = path.join(process.resourcesPath || __dirname, 'nse_config.ini');
        if (fs.existsSync(bundled)) {
            writeConfigFile(CONFIG_PATH, fs.readFileSync(bundled, 'utf8'));
        } else {
            const loader = new ConfigLoader(CONFIG_PATH);
            loader.createDefaultConfig();
            readConfigFile(CONFIG_PATH);
        }
    }

    // Keep the company display name out of editable INI configuration. On
    // upgrades, migrate the old value to Windows-protected per-user storage.
    try {
        let content = readConfigFile(CONFIG_PATH);
        const parsed = ini.parse(content);
        initializeCompanyName(parsed.company && parsed.company.name ? String(parsed.company.name).trim() : '');
        if (Object.prototype.hasOwnProperty.call(parsed, 'company')) {
            delete parsed.company;
            writeConfigFile(CONFIG_PATH, ini.stringify(parsed));
        }
    } catch (e) {
        console.error('[main] ensureConfig company check failed:', e.message);
    }
}

function createWindow() {
    const primary = screen.getPrimaryDisplay();
    const wa = primary.workAreaSize;

    mainWindow = new BrowserWindow({
        x: 0,
        y: 0,
        width: wa.width,
        height: wa.height,
        minWidth: 1000,
        minHeight: 600,
        show: false,
        frame: true,
        autoHideMenuBar: true,
        title: 'NSEFO/BSEFO DropCopy Client V2.0',
        icon: path.join(__dirname, 'assets', 'app-icon.png'),
        backgroundColor: '#0f172a',
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false
        }
    });

    mainWindow.setMenu(null);
    mainWindow.setMenuBarVisibility(false);
    mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

    mainWindow.once('ready-to-show', () => {
        mainWindow.maximize();
        mainWindow.setBounds({ x: 0, y: 0, width: wa.width, height: wa.height });
        mainWindow.show();
        mainWindow.focus();
    });

    mainWindow.on('closed', () => { mainWindow = null; });
}

function createApplicationMenu() {
    logsMenuItem = null;
    Menu.setApplicationMenu(null);
}

async function chooseDataFolder(key, title) {
    if ((client && client.running) || (bseClient && bseClient.running)) {
        await dialog.showMessageBox(mainWindow, {
            type: 'warning', title: 'Stop dropcopy first',
            message: 'Stop NSEFO and BSEFO before changing folders.'
        });
        return;
    }
    const current = key === 'csvOutputDir' ? CSV_OUTPUT_DIR : CSV_BACKUP_DIR;
    const result = await dialog.showOpenDialog(mainWindow, {
        title, defaultPath: current, properties: ['openDirectory', 'createDirectory']
    });
    if (result.canceled || !result.filePaths.length) return;
    const oldSetting = appSettings[key];
    const selected = path.resolve(result.filePaths[0]);
    try {
        appSettings[key] = selected;
        if (key === 'csvOutputDir') CSV_OUTPUT_DIR = selected;
        else CSV_BACKUP_DIR = selected;
        ensureDirs();
        saveAppSettings();
        if (key === 'csvOutputDir') {
            ensureConfig();
            ensureNseOutputConfig();
            ensureBseFiles();
        }
        await dialog.showMessageBox(mainWindow, {
            type: 'info', title: 'Folder saved', message: `${title}:`, detail: selected
        });
    } catch (e) {
        appSettings[key] = oldSetting;
        if (key === 'csvOutputDir') CSV_OUTPUT_DIR = path.resolve(oldSetting || DEFAULT_CSV_OUTPUT_DIR);
        else CSV_BACKUP_DIR = path.resolve(oldSetting || path.join(INSTALL_DIR, 'Backup'));
        await dialog.showErrorBox('Could not save folder', e.message);
    }
}

ipcMain.handle('view:setLogsVisible', (_event, visible) => {
    if (logsMenuItem) logsMenuItem.checked = Boolean(visible);
});

ipcMain.handle('settings:action', async (_event, action) => {
    switch (String(action || '')) {
        case 'choose-output': return chooseDataFolder('csvOutputDir', 'Choose the folder for NSEFO and BSEFO CSV output');
        case 'choose-backup': return chooseDataFolder('csvBackupDir', 'Choose the folder for timestamped CSV backups');
        case 'open-nse-csv': return shell.openPath(getNseCsvPath());
        case 'open-bse-csv': return shell.openPath(getBseCsvPaths().customCsv);
        case 'about': return dialog.showMessageBox(mainWindow, {
            type: 'info', title: 'About NSE / BSE DropCopy Client',
            message: 'NSE / BSE DropCopy Client',
            detail: `Real-time trade monitoring for NSEFO and BSEFO.\n\nBuild ID: ${BUILD_ID}`
        });
        case 'exit': app.quit(); return { ok: true };
        default: return { ok: false, error: 'Unknown settings action.' };
    }
});

function send(channel, payload) {
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(channel, payload);
    }
}

function publishStats(exchange, stats) {
    const name = exchange === 'BSE' ? 'BSEFO' : 'NSEFO';
    exchangeStats[name] = { ...exchangeStats[name], ...stats };
    send('client:stats', { exchange: name, ...exchangeStats[name] });
}

function wireClientEvents(c) {
    c.on('status', d => send('client:status', { ...d, exchange: 'NSEFO' }));
    c.on('login', d => send('client:login', d));
    c.on('trade', d => send('client:trade', { ...d, exchange: 'NSEFO' }));
    c.on('heartbeat', d => send('client:heartbeat', d));
    c.on('reset', d => send('client:reset', { ...d, exchange: 'NSEFO' }));
    c.on('stats', d => publishStats('NSE', d));
    if (c.logger && typeof c.logger.onLog === 'function') {
        c.logger.onLog((level, message) => send('client:log', { level, message }));
    }
}

ipcMain.handle('app:getPaths', () => ({ configPath: CONFIG_PATH, settingDir: SETTING_DIR, outputDir: CSV_OUTPUT_DIR, backupDir: CSV_BACKUP_DIR, contractDir: CONTRACT_DIR, logDir: LOG_DIR }));
ipcMain.handle('client:setExchange', (_event, exchange) => {
    activeExchange = String(exchange).toUpperCase() === 'BSE' ? 'BSE' : 'NSE';
    const stats = activeExchange === 'BSE' ? (bseClient ? bseClient.getStats() : exchangeStats.BSEFO) : (client ? client.getStats() : exchangeStats.NSEFO);
    return { ok: true, running: !!(stats && stats.running), connected: !!(stats && stats.connected) };
});

ipcMain.handle('app:getCompanyName', () => {
    try {
        ensureConfig();
        return readCompanyName() || DEFAULT_COMPANY_NAME;
    } catch (e) {
        console.error('[main] company name read error:', e.message);
        return DEFAULT_COMPANY_NAME;
    }
});

ipcMain.handle('client:start', async (_event, exchange = 'NSE') => {
    const selected = String(exchange).toUpperCase() === 'BSE' ? 'BSE' : 'NSE';
    if ((selected === 'NSE' && client && client.running) || (selected === 'BSE' && bseClient && bseClient.running)) return { ok: false, error: `${selected}FO is already running.` };
    try {
        ensureDirs();
        activeExchange = selected;
        if (activeExchange === 'BSE') {
            startBse();
            return { ok: true };
        }
        const config = loadNseConfig();
        config.csv_output.output_dir = CSV_OUTPUT_DIR;
        config.logging.log_file = datedLogBase();

        client = new DropCopyClient(config);
        wireClientEvents(client);

        const runningClient = client;
        runningClient.run().catch(err => {
            send('client:log', { level: 'ERROR', message: err.message });
            send('client:status', { connected: false, running: false, exchange: 'NSEFO' });
        }).finally(() => {
            if (client === runningClient) {
                if (statsIntervals.NSE) clearInterval(statsIntervals.NSE);
                statsIntervals.NSE = null;
                publishStats('NSE', runningClient.getStats());
            }
        });

        statsIntervals.NSE = setInterval(() => { if (client && client.running) publishStats('NSE', client.getStats()); }, 250);
        return { ok: true };
    } catch (e) {
        return { ok: false, error: e.message };
    }
});

ipcMain.handle('client:stop', async (_event, exchange = activeExchange) => {
    try {
        const selected = String(exchange).toUpperCase() === 'BSE' ? 'BSE' : 'NSE';
        activeExchange = selected;
        if (selected === 'NSE' && client) client.disconnect(true);
        const stoppingBse = selected === 'BSE' ? bseClient : null;
        if (stoppingBse) await stoppingBse.stop();
        if (stoppingBse) publishStats('BSE', exchangeStats.BSEFO);
        if (selected === 'NSE' && client) publishStats('NSE', client.getStats());
        if (statsIntervals[selected]) clearInterval(statsIntervals[selected]);
        statsIntervals[selected] = null;
        send('client:status', { connected: false, running: false, exchange: selected === 'BSE' ? 'BSEFO' : 'NSEFO' });
        return { ok: true };
    } catch (e) {
        return { ok: false, error: e.message };
    }
});

ipcMain.handle('client:stats', () => activeExchange === 'BSE' ? exchangeStats.BSEFO : exchangeStats.NSEFO);

ipcMain.handle('trades:load', () => {
    try {
        const nsePath = getNseCsvPath();
        const bsePath = getBseCsvPaths().customCsv;
        const nseRows = readCsvRows(nsePath).map(row => ({ ...row, exchange: 'NSEFO' }));
        const bseRows = readCsvRows(bsePath).map(row => ({ ...row, exchange: 'BSEFO' }));
        return nseRows.concat(bseRows).sort((a, b) => String(a.timestamp || '').localeCompare(String(b.timestamp || '')));
    } catch { return []; }
});

ipcMain.handle('trades:openCsv', () => {
    const csvPath = activeExchange === 'BSE' ? getBseCsvPaths().customCsv : getNseCsvPath();
    if (fs.existsSync(csvPath)) shell.openPath(csvPath);
});

ipcMain.handle('trades:openFolder', () => shell.openPath(activeExchange === 'BSE' ? path.dirname(getBseCsvPaths().customCsv) : CSV_OUTPUT_DIR));

ipcMain.handle('config:getExchange', (_event, exchange) => {
    try {
        const selected = String(exchange).toUpperCase() === 'BSE' ? 'BSE' : 'NSE';
        let config;
        const managedFields = selected === 'BSE' ? [] : ['logging.log_file'];
        const hiddenFields = selected === 'BSE' ? ['FILES.log_file'] : [];
        if (selected === 'BSE') config = ini.parse(readConfigFile(ensureBseFiles()));
        else {
            ensureConfig(); ensureNseOutputConfig();
            config = ini.parse(readConfigFile(CONFIG_PATH));
        }
        return { ok: true, exchange: selected, config, managedFields, hiddenFields };
    } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('config:saveExchange', (_event, exchange, config) => {
    try {
        const selected = String(exchange).toUpperCase() === 'BSE' ? 'BSE' : 'NSE';
        if ((selected === 'NSE' && client && client.running) || (selected === 'BSE' && bseClient && bseClient.running)) {
            return { ok: false, error: `Stop ${selected}FO before saving its configuration.` };
        }
        if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('Invalid configuration form data.');
        const configPath = selected === 'BSE' ? ensureBseFiles() : CONFIG_PATH;
        if (selected === 'NSE') {
            config.csv_output = config.csv_output || {};
            const enteredPath = String(config.csv_output.output_dir || '').trim();
            if (!enteredPath) throw new Error('Choose an NSEFO output directory.');
            CSV_OUTPUT_DIR = path.isAbsolute(enteredPath) ? path.resolve(enteredPath) : path.resolve(INSTALL_DIR, enteredPath);
            fs.mkdirSync(CSV_OUTPUT_DIR, { recursive: true });
            appSettings.csvOutputDir = CSV_OUTPUT_DIR;
            saveAppSettings();
            config.csv_output.output_dir = CSV_OUTPUT_DIR;
        } else {
            config.FILES = config.FILES || {};
            const outputCsv = String(config.FILES.output_csv || '').trim();
            if (outputCsv) {
                const outputCsvPath = path.isAbsolute(outputCsv) ? path.resolve(outputCsv) : path.resolve(SETTING_DIR, outputCsv);
                CSV_OUTPUT_DIR = path.dirname(outputCsvPath);
                fs.mkdirSync(CSV_OUTPUT_DIR, { recursive: true });
                appSettings.csvOutputDir = CSV_OUTPUT_DIR;
                saveAppSettings();
                config.FILES.output_csv = path.join(CSV_OUTPUT_DIR, 'trades_dropcopy.csv');
            }
            const customCsv = String(config.FILES.custom_csv || '').trim();
            if (customCsv) {
                const customCsvPath = path.isAbsolute(customCsv) ? path.resolve(customCsv) : path.resolve(SETTING_DIR, customCsv);
                fs.mkdirSync(path.dirname(customCsvPath), { recursive: true });
                config.FILES.custom_csv = customCsvPath;
            }
        }
        writeConfigFile(configPath, ini.stringify(config));
        if (selected === 'BSE') { ensureBseFiles(); ensureNseOutputConfig(); }
        else { ensureConfig(); ensureNseOutputConfig(); ensureBseFiles(); }
        return { ok: true };
    } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('config:choosePath', async (_event, exchange, section, key, currentPath) => {
    const selected = String(exchange).toUpperCase() === 'BSE' ? 'BSE' : 'NSE';
    const field = String(section || '').toLowerCase() + '.' + String(key || '').toLowerCase();
    const isDirectory = (selected === 'NSE' && field === 'csv_output.output_dir') ||
        (selected === 'BSE' && ['files.custom_csv', 'files.output_csv'].includes(field));
    const allowedBse = ['files.ca_cert', 'files.custom_csv', 'files.output_csv', 'files.eqd_contract', 'files.eq_scrip'];
    if (!isDirectory && !(selected === 'BSE' && allowedBse.includes(field))) return { ok: false, error: 'This path cannot be changed here.' };
    const title = `${selected}FO ${String(key).replace(/_/g, ' ')}`;
    if (isDirectory) {
        const result = await dialog.showOpenDialog(mainWindow, { title, defaultPath: currentPath || CSV_OUTPUT_DIR, properties: ['openDirectory', 'createDirectory'] });
        return { ok: true, canceled: result.canceled, path: result.filePaths && result.filePaths[0] };
    }
    if (field === 'files.custom_csv' || field === 'files.log_file') {
        const result = await dialog.showSaveDialog(mainWindow, { title, defaultPath: currentPath || undefined, filters: [{ name: field === 'files.custom_csv' ? 'CSV files' : 'Log files', extensions: [field === 'files.custom_csv' ? 'csv' : 'log'] }] });
        return { ok: true, canceled: result.canceled, path: result.filePath };
    }
    const result = await dialog.showOpenDialog(mainWindow, { title, defaultPath: currentPath || undefined, properties: ['openFile'] });
    return { ok: true, canceled: result.canceled, path: result.filePaths && result.filePaths[0] };
});

app.whenReady().then(() => {
    if (!ownsSingleInstance) return app.quit();
    try {
        initializeAppSettings();
        ensureDirs();
        ensureConfig();
        ensureNseOutputConfig();
        ensureBseFiles();
        backupAndClearTradeCsvs();
        createApplicationMenu();
        createWindow();
    } catch (e) {
        const message = `The application could not create or access its setting/data folders.\n\nFolder: ${SETTING_DIR}\n\n${e.message}\n\nInstall the application for the current Windows user or choose an installation folder where your account can write.`;
        dialog.showErrorBox('DropCopy folder setup failed', message);
        app.quit();
    }

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        } else if (mainWindow) {
            mainWindow.maximize();
            mainWindow.focus();
        }
    });
});

app.on('window-all-closed', () => {
    if (client) client.disconnect(true);
    if (bseClient) bseClient.stop();
    for (const key of ['NSE', 'BSE']) if (statsIntervals[key]) clearInterval(statsIntervals[key]);
    if (process.platform !== 'darwin') app.quit();
});

let waitingForBseClose = false;
app.on('before-quit', event => {
    if (waitingForBseClose || !bseClient) return;
    event.preventDefault();
    waitingForBseClose = true;
    bseClient.stop().finally(() => app.quit());
});
