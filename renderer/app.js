'use strict';

const $ = id => document.getElementById(id);

// ---- Column definitions (matches client CSV order) ----
const COLUMNS = [
    { key: 'processed_time',       label: 'Processed'      },
    { key: 'timestamp',            label: 'Time'           },
    { key: 'event_type',           label: 'Event'          },
    { key: 'trade_number',         label: 'Trade #'        },
    { key: 'order_number',         label: 'Order #'        },
    { key: 'symbol',               label: 'Symbol'         },
    { key: 'instrument_type',      label: 'Inst'           },
    { key: 'expiry_date',          label: 'Expiry'         },
    { key: 'strike_price',         label: 'Strike'         },
    { key: 'option_type',          label: 'Opt'            },
    { key: 'buy_sell',             label: 'Side'           },
    { key: 'trade_quantity',       label: 'Qty'            },
    { key: 'trade_price',          label: 'Price'          },
    { key: 'original_volume',      label: 'Orig Vol'       },
    { key: 'remaining_volume',     label: 'Rem Vol'        },
    { key: 'account_number',       label: 'Account'        },
    { key: 'broker_id',            label: 'Broker'         },
    { key: 'trader_id',            label: 'Trader'         },
    { key: 'counter_order_number', label: 'Counter Ord #'  },
    { key: 'counter_broker_id',    label: 'Ctr Broker'     },
    { key: 'activity_type',        label: 'Act'            },
    { key: 'activity_time',        label: 'Act Time'       },
    { key: 'book_type',            label: 'Book'           },
    { key: 'open_close',           label: 'O/C'            },
    { key: 'pan_number',           label: 'PAN'            },
    { key: 'algo_id',              label: 'Algo'           },
    { key: 'order_flags',          label: 'Flags'          },
    { key: 'giveup_trade',         label: 'Giveup'         }
];

const MAX_ROWS = 5000;
const MAX_DISPLAY = 2000;
const allTrades = [];
let globalSearch = '';
const columnFilters = {};

const statusBadge = $('statusBadge');
const startBtn = $('startBtn');
const stopBtn = $('stopBtn');
const tradesBody = $('tradesBody');
const tradeCount = $('tradeCount');
const rowCount = $('rowCount');
const logsEl = $('logs');
const headerRow = $('headerRow');
const filterRow = $('filterRow');
const tableWrap = $('tableWrap');
const globalSearchEl = $('globalSearch');
const autoScrollChk = $('autoScrollChk');

function buildTable() {
    headerRow.innerHTML = COLUMNS.map(c => `<th title="${c.key}">${c.label}</th>`).join('');
    filterRow.innerHTML = COLUMNS.map(c =>
        `<th><input type="text" data-col="${c.key}" placeholder="filter" /></th>`
    ).join('');

    filterRow.querySelectorAll('input[data-col]').forEach(inp => {
        let timer = null;
        inp.addEventListener('input', () => {
            clearTimeout(timer);
            timer = setTimeout(() => {
                columnFilters[inp.dataset.col] = inp.value.trim().toLowerCase();
                renderTable();
            }, 150);
        });
    });
}

function rowMatches(row) {
    if (globalSearch) {
        let found = false;
        for (const c of COLUMNS) {
            const v = String(row[c.key] || '').toLowerCase();
            if (v.includes(globalSearch)) { found = true; break; }
        }
        if (!found) return false;
    }
    for (const c of COLUMNS) {
        const need = columnFilters[c.key];
        if (!need) continue;
        const v = String(row[c.key] || '').toLowerCase();
        if (!v.includes(need)) return false;
    }
    return true;
}

function getFilteredTrades() {
    const out = [];
    for (let i = 0; i < allTrades.length; i++) {
        if (rowMatches(allTrades[i])) {
            out.push(allTrades[i]);
            if (out.length >= MAX_DISPLAY) break;
        }
    }
    return out;
}

function cellHTML(key, value) {
    const v = value === undefined || value === null ? '' : String(value);
    const vEsc = escapeHtml(v);
    if (key === 'buy_sell') {
        const cls = v === 'BUY' ? 'side-buy' : v === 'SELL' ? 'side-sell' : '';
        return `<td class="${cls}">${vEsc}</td>`;
    }
    if (key === 'trade_price' || key === 'strike_price')
        return `<td class="price">${vEsc}</td>`;
    if (key === 'symbol')
        return `<td class="symbol-cell">${vEsc}</td>`;
    return `<td>${vEsc}</td>`;
}

function rowToHTML(r) {
    return '<tr>' + COLUMNS.map(c => cellHTML(c.key, r[c.key])).join('') + '</tr>';
}

function renderTable() {
    const filtered = getFilteredTrades();

    if (filtered.length === 0) {
        tradesBody.innerHTML =
            `<tr><td class="empty" colspan="${COLUMNS.length}">${
                allTrades.length === 0
                    ? 'No trades yet. Click Start to connect.'
                    : 'No trades match the current filters.'
            }</td></tr>`;
    } else {
        tradesBody.innerHTML = filtered.map(rowToHTML).join('');
    }

    rowCount.textContent = filtered.length + ' / ' + allTrades.length + ' rows';
    tradeCount.textContent = allTrades.length + ' trades';
}

function addTrade(t) {
    allTrades.unshift(t);
    while (allTrades.length > MAX_ROWS) allTrades.pop();

    const hasFilters = globalSearch || Object.values(columnFilters).some(v => v);

    if (hasFilters) {
        // Filtered view: only re-render if this trade matches
        if (rowMatches(t)) {
            const emptyRow = tradesBody.querySelector('.empty');
            if (emptyRow) emptyRow.parentElement.remove();
            const tr = document.createElement('tr');
            tr.className = 'new-trade';
            tr.innerHTML = COLUMNS.map(c => cellHTML(c.key, t[c.key])).join('');
            tradesBody.insertBefore(tr, tradesBody.firstChild);
            while (tradesBody.children.length > MAX_DISPLAY) {
                tradesBody.removeChild(tradesBody.lastChild);
            }
            const visible = tradesBody.querySelectorAll('tr').length;
            rowCount.textContent = visible + ' / ' + allTrades.length + ' rows';
        } else {
            rowCount.textContent = getFilteredTrades().length + ' / ' + allTrades.length + ' rows';
        }
    } else {
        const emptyRow = tradesBody.querySelector('.empty');
        if (emptyRow) emptyRow.parentElement.remove();

        const tr = document.createElement('tr');
        tr.className = 'new-trade';
        tr.innerHTML = COLUMNS.map(c => cellHTML(c.key, t[c.key])).join('');
        tradesBody.insertBefore(tr, tradesBody.firstChild);

        while (tradesBody.children.length > MAX_DISPLAY) {
            tradesBody.removeChild(tradesBody.lastChild);
        }
        rowCount.textContent = tradesBody.children.length + ' / ' + allTrades.length + ' rows';
    }

    tradeCount.textContent = allTrades.length + ' trades';

    if (autoScrollChk.checked && !hasFilters) {
        tableWrap.scrollTop = 0;
    }
}

globalSearchEl.addEventListener('input', () => {
    globalSearch = globalSearchEl.value.trim().toLowerCase();
    renderTable();
});

$('clearFiltersBtn').addEventListener('click', () => {
    globalSearchEl.value = '';
    globalSearch = '';
    filterRow.querySelectorAll('input[data-col]').forEach(inp => inp.value = '');
    for (const k of Object.keys(columnFilters)) delete columnFilters[k];
    renderTable();
});

// ---- IPC / client events ----
window.api.onStatus(d => {
    if (d.running || d.connected) setStatus(d.connected ? 'online' : 'connecting');
    else setStatus('offline');
});

window.api.onLogin(d => {
    if (d.success) addLog('INFO', 'Login successful. Streams: ' + JSON.stringify(d.streams));
});

window.api.onStats(d => {
    $('statRuntime').textContent = formatRuntime(d.runtime);
    $('statTradesReceived').textContent = d.tradesReceived;
    $('statTradesWritten').textContent = d.tradesWritten;
    $('statHeartbeats').textContent = d.heartbeatsSent;
    $('statPackets').textContent = d.dataReceived;
    $('statBatches').textContent = d.downloadBatches || 0;

    if (d.running && d.connected) {
        setStatus('online');
        startBtn.disabled = true; stopBtn.disabled = false;
    } else if (d.running) {
        setStatus('connecting');
        startBtn.disabled = true; stopBtn.disabled = false;
    } else {
        setStatus('offline');
        startBtn.disabled = false; stopBtn.disabled = true;
    }
});

window.api.onTrade(addTrade);
window.api.onHeartbeat(hb => addLog('DEBUG', '💓 Heartbeat ' + hb.direction + ' @ ' + hb.time));
window.api.onLog(d => addLog(d.level, d.message));

// ---- Actions ----
startBtn.addEventListener('click', async () => {
    startBtn.disabled = true;
    setStatus('connecting');
    addLog('INFO', 'Starting client...');
    const res = await window.api.start();
    if (!res.ok) {
        addLog('ERROR', res.error || 'Failed to start');
        startBtn.disabled = false;
        setStatus('offline');
    }
});

stopBtn.addEventListener('click', async () => {
    addLog('INFO', 'Stopping client...');
    await window.api.stop();
    startBtn.disabled = false; stopBtn.disabled = true;
    setStatus('offline');
});

$('csvBtn').addEventListener('click', () => window.api.openCsv());
$('folderBtn').addEventListener('click', () => window.api.openFolder());
$('configBtn').addEventListener('click', () => window.api.openConfigFile());
$('clearLogsBtn').addEventListener('click', () => logsEl.innerHTML = '');

// ---- Helpers ----
function setStatus(state) {
    statusBadge.className = 'badge';
    if (state === 'online') {
        statusBadge.classList.add('badge-online');
        statusBadge.textContent = '● Connected';
    } else if (state === 'connecting') {
        statusBadge.classList.add('badge-connecting');
        statusBadge.textContent = '● Connecting...';
    } else {
        statusBadge.classList.add('badge-offline');
        statusBadge.textContent = '● Disconnected';
    }
}

function formatRuntime(seconds) {
    const h = String(Math.floor(seconds / 3600)).padStart(2, '0');
    const m = String(Math.floor((seconds % 3600) / 60)).padStart(2, '0');
    const s = String(seconds % 60).padStart(2, '0');
    return h + ':' + m + ':' + s;
}

function addLog(level, message) {
    const time = new Date().toLocaleTimeString();
    const line = document.createElement('div');
    line.className = 'log-line log-' + level;
    line.innerHTML = '<span class="log-time">[' + time + ']</span>' + escapeHtml(message);
    logsEl.appendChild(line);
    logsEl.scrollTop = logsEl.scrollHeight;
    while (logsEl.children.length > 500) logsEl.removeChild(logsEl.firstChild);
}

function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ---- Init ----
buildTable();

(async () => {
    try {
        const trades = await window.api.loadTrades();
        if (trades && trades.length) {
            trades.slice().reverse().forEach(t => {
                allTrades.push(t);
                if (allTrades.length > MAX_ROWS) allTrades.pop();
            });
            renderTable();
            addLog('INFO', 'Loaded ' + trades.length + ' existing trades from CSV');
        }
    } catch (e) {
        addLog('ERROR', 'Load trades failed: ' + e.message);
    }
})();