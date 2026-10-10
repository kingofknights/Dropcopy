'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

function pad(value) { return String(value).padStart(2, '0'); }

const now = new Date();
const buildId = [
    now.getFullYear(), pad(now.getMonth() + 1), pad(now.getDate())
].join('') + '-' + pad(now.getHours()) + pad(now.getMinutes()) + pad(now.getSeconds());

// Keep the Windows file version valid (the final version component must fit
// within 16 bits) while the full timestamp remains available as the build ID.
const buildNumber = String(now.getHours() * 60 + now.getMinutes() + 1);
const infoPath = path.join(__dirname, 'build-info.json');
fs.writeFileSync(infoPath, JSON.stringify({ buildId }, null, 2) + '\n', 'utf8');

const builderCli = path.join(__dirname, 'node_modules', 'electron-builder', 'cli.js');
const result = spawnSync(process.execPath, [builderCli, '--win', '--x64'], {
    cwd: __dirname,
    stdio: 'inherit',
    env: { ...process.env, BUILD_NUMBER: buildNumber }
});

if (result.error) throw result.error;
process.exitCode = result.status == null ? 1 : result.status;
