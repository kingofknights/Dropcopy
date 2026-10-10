'use strict';

// Native Node.js implementation of the BSE ETI drop-copy client. The frame
// layouts, template IDs, and trade-field offsets follow the supplied Python
// client (BSE ETI Interface 2.4).
const fs = require('fs');
const path = require('path');
const net = require('net');
const tls = require('tls');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const ini = require('ini');

const T = {
  CONN_GW_REQ: 10020, CONN_GW_RSP: 10022,
  SESSION_REG_REQ: 10053, SESSION_REG_RSP: 10054,
  SESSION_LOGON: 10000, SESSION_LOGON_RSP: 10001,
  USER_LOGON: 10018, USER_LOGON_RSP: 10019,
  LOGOUT: 10012, SUBSCRIBE: 10025, SUBSCRIBE_RSP: 10005,
  SESSION_LIST_REQ: 10035, SESSION_LIST_RSP: 10036,
  RETRANSMIT: 10008, RETRANSMIT_RSP: 10009, REJECT: 10010,
  HEARTBEAT: 10011, HEARTBEAT_NTF: 10023,
  SERVICE_AVAIL: 10030, TRADE: 10500, END_TRADE: 10501
};
const NO = {
  I32: -2147483648, I64: -(1n << 63n), U8: 255, U32: 0xffffffff,
  U64: (1n << 64n) - 1n
};
const MAX_FRAME = 16 * 1024 * 1024;
const IST_OFFSET = 330 * 60 * 1000;
const MAIN_BASIC = [
  'EventType','Date','Time','Date_Recv','Time_Recv','SecurityID','MarketSegmentID',
  'LastPx','LastQty','Side','OrderID','CIOrdID','TradeID','OrigTradeID','SideTradeID',
  'TrdMatchID','RootPartyIDExecutingUnit','RootPartyIDSessionID',
  'RootPartyIDExecutingTrader','CumQty','LeavesQty','ClearingTradeQty','AccountType','MatchDate'
];
const MAIN_EXT = [
  'Price','RelatedSecurityID','SideLastPx','SideLastQty','ClearingTradePrice','Yield',
  'UnderlyingDirtyPrice','Date_Act','Time_Act','SenderLocationID','MessageTag','RelatedSymbol',
  'StrategyLinkID','TotNumTradeReports','MultiLegReportingType','TradeReportType',
  'TransferReason','RolloverFlag','MatchType','MatchSubType','AggressorIndicator',
  'TradingCapacity','PositionEffect','CustOrderHandlingInst','AlgoID','ClientCode','CPCode',
  'FreeText3','OrderCategory','OrdType','RelatedProductComplex','OrderSide',
  'RootPartyExecutingFirm','RootPartyExecutingTraderName'
];
const CUSTOM_COLUMNS = [
  'member_id','trader_id','instrument','token','symbol','expiry_date','strike_price',
  'option_type','buy_sell','ex_qty','ex_price','clnt_id','order_no','trade_no','pan','nnf',
  'timestamp','time','trade_status','algo_id'
];

function u16(n) { const b = Buffer.alloc(2); b.writeUInt16LE(Number(n) >>> 0); return b; }
function u32(n) { const b = Buffer.alloc(4); b.writeUInt32LE(Number(n) >>> 0); return b; }
function i32(n) { const b = Buffer.alloc(4); b.writeInt32LE(Number(n)); return b; }
function u64(n) { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; }
function pad8(b) { const n = (8 - (b.length % 8)) % 8; return n ? Buffer.concat([b, Buffer.alloc(n)]) : b; }
function fixedText(value, length) { const b = Buffer.from(String(value || ''), 'latin1'); return b.length >= length ? b.subarray(0, length) : Buffer.concat([b, Buffer.alloc(length - b.length)]); }
function clean32(n) { return n === NO.I32 ? '' : n; }
function clean64(n) { return n === NO.I64 ? '' : n.toString(); }
function cleanU32(n) { return n === NO.U32 ? '' : n; }
function cleanU64(n) { return n === NO.U64 ? '' : n.toString(); }
function cleanU8(n) { return n === NO.U8 ? '' : n; }
function price8(n) { return n === NO.I64 ? '' : (Number(n) / 1e8).toFixed(8); }
function price2(n) { const v = Number(n); return Number.isFinite(v) ? v.toFixed(2) : ''; }
function strikeRupees(raw) { const v = Number(raw); return Number.isFinite(v) ? (v / 100).toFixed(2) : ''; }
function asInt(value, fallback = 0) {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  const s = String(value).split(/[;#]/, 1)[0].trim();
  return /^0x/i.test(s) ? parseInt(s, 16) : parseInt(s, 10);
}
function istParts(ns) {
  if (!ns || ns === NO.U64) return ['', ''];
  const d = new Date(Number(ns / 1000000n) + IST_OFFSET);
  return [d.toISOString().slice(0, 10), d.toISOString().slice(11, 19)];
}
function nowIst() {
  const d = new Date(Date.now() + IST_OFFSET);
  return [d.toISOString().slice(0, 10), d.toISOString().slice(11, 19)];
}
function csvParse(text) {
  const rows = []; let row = []; let field = ''; let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field.replace(/\r$/, '')); rows.push(row); row = []; field = ''; }
    else field += c;
  }
  if (field.length || row.length) { row.push(field.replace(/\r$/, '')); rows.push(row); }
  return rows;
}
function csvEscape(value) {
  const s = value === undefined || value === null ? '' : String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function readIniConfig(configSource, home) {
  const raw = typeof configSource === 'string'
    ? ini.parse(fs.readFileSync(configSource, 'utf8'))
    : (configSource || {});
  const d = raw.DROPCOPY || {}, f = raw.FILES || {}, s = raw.SESSION || {};
  const timing = raw.TIMING || {}, output = raw.OUTPUT || {}, rt = raw.RETRANSMIT || {};
  const resolve = p => path.isAbsolute(p || '') ? p : path.resolve(home, p || '');
  const delimiterName = String(output.delimiter || 'comma').toLowerCase();
  return {
    cgHost: d.cg_host || '', cgPort: asInt(d.cg_port), sessionId: asInt(d.session_id),
    userId: asInt(d.user_id), password: String(process.env.BSE_DROPCOPY_PASSWORD || d.password || ''),
    memberId: asInt(d.member_id), refApplId: asInt(d.ref_appl_id, 1),
    partitionWhitelist: String(d.partition_whitelist || '0xFFFFFFFF'),
    prioritySessions: String(d.priority_sessions || '').trim(),
    caCert: resolve(f.ca_cert || 'gw-ca-cert.pem'),
    outputCsv: resolve(f.output_csv || 'trades_dropcopy.csv'),
    customCsv: resolve(f.custom_csv || ''), eqdContract: resolve(f.eqd_contract || ''),
    eqScrip: resolve(f.eq_scrip || ''), logFile: resolve(f.log_file || 'dropcopy.log'),
    heartbeatSec: asInt(s.heartbeat_sec, 60), ifaceVersion: String(s.iface_version || '2.4'),
    responseTimeout: asInt(timing.response_timeout_sec, 20),
    retransmitTimeout: asInt(timing.retransmit_timeout_sec, 5),
    heartbeatMargin: Number(timing.heartbeat_margin || 0.9),
    retransmitPause: Number(timing.retransmit_pause || 0),
    csvMode: String(output.mode || 'append').toLowerCase(),
    delimiter: ({ comma: ',', semicolon: ';', tab: '\t', pipe: '|' })[delimiterName] || ',',
    verbose: String(output.verbose === undefined ? 'true' : output.verbose).toLowerCase() !== 'false',
    retransmitEnabled: String(rt.enabled || 'false').toLowerCase() === 'true',
    retransmitBegin: asInt(rt.begin_seq, 1), retransmitPause: Number(timing.retransmit_pause || 0),
    retransmitPartitions: String(rt.partition_range || '1-16')
  };
}

// Python source uses GCM's CTR keystream construction with the 16-byte IV
// provided by the gateway. No authentication tag is present in this ETI mode.
class BseCipher {
  constructor(key, iv) {
    this.key = key; this.j0 = BseCipher.computeJ0(key, iv); this.txPos = 0; this.rxPos = 0;
  }
  static aesBlock(key, block) {
    const c = crypto.createCipheriv('aes-256-ecb', key, null);
    c.setAutoPadding(false);
    return Buffer.concat([c.update(block), c.final()]);
  }
  static gfMul(x, y) {
    const mask = (1n << 128n) - 1n, r = 0xe1000000000000000000000000000000n;
    let z = 0n, v = y;
    for (let i = 0; i < 128; i++) {
      if ((x >> BigInt(127 - i)) & 1n) z ^= v;
      v = (v & 1n) ? ((v >> 1n) ^ r) : (v >> 1n);
    }
    return z & mask;
  }
  static computeJ0(key, iv) {
    if (iv.length === 12) return BigInt(`0x${Buffer.concat([iv, Buffer.from([0, 0, 0, 1])]).toString('hex')}`);
    const h = BigInt(`0x${BseCipher.aesBlock(key, Buffer.alloc(16)).toString('hex')}`);
    const bitLength = BigInt(iv.length * 8);
    const paddedLength = Math.ceil(iv.length / 16) * 16;
    const data = Buffer.concat([iv, Buffer.alloc(paddedLength - iv.length), Buffer.alloc(8), u64be(bitLength)]);
    let y = 0n;
    for (let i = 0; i < data.length; i += 16) {
      const block = BigInt(`0x${data.subarray(i, i + 16).toString('hex')}`);
      y = BseCipher.gfMul(y ^ block, h);
    }
    return y;
  }
  keystream(offset, length) {
    const start = Math.floor(offset / 16), skip = offset % 16;
    const blocks = Math.ceil((skip + length) / 16), chunks = [];
    for (let i = 0; i < blocks; i++) {
      const ctr = (this.j0 + BigInt(start + i + 1)) & ((1n << 128n) - 1n);
      chunks.push(BseCipher.aesBlock(this.key, bigintBuffer(ctr, 16)));
    }
    return Buffer.concat(chunks).subarray(skip, skip + length);
  }
  crypt(buf, direction) {
    const posKey = direction === 'tx' ? 'txPos' : 'rxPos';
    const stream = this.keystream(this[posKey], buf.length); this[posKey] += buf.length;
    const out = Buffer.alloc(buf.length);
    for (let i = 0; i < buf.length; i++) out[i] = buf[i] ^ stream[i];
    return out;
  }
}
function u64be(n) { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n)); return b; }
function bigintBuffer(n, len) { const b = Buffer.alloc(len); let x = BigInt(n); for (let i = len - 1; i >= 0; i--) { b[i] = Number(x & 255n); x >>= 8n; } return b; }

class FrameSocket {
  constructor(socket) {
    this.socket = socket; this.buffer = Buffer.alloc(0); this.waiters = [];
    socket.on('data', chunk => { this.buffer = Buffer.concat([this.buffer, chunk]); this.flush(); });
    socket.on('error', err => this.rejectAll(err));
    socket.on('close', () => this.rejectAll(new Error('socket closed')));
  }
  rejectAll(err) { while (this.waiters.length) { const w = this.waiters.shift(); clearTimeout(w.timer); w.reject(err); } }
  flush() {
    while (this.waiters.length) {
      const w = this.waiters[0];
      if (this.buffer.length < 4) return;
      const length = this.buffer.readUInt32LE(0);
      if (length < 8 || length > MAX_FRAME) { this.waiters.shift(); clearTimeout(w.timer); w.reject(new Error(`Invalid BSE frame length ${length}`)); continue; }
      if (this.buffer.length < length) return;
      const frame = this.buffer.subarray(0, length); this.buffer = this.buffer.subarray(length);
      this.waiters.shift(); clearTimeout(w.timer); w.resolve(frame);
    }
  }
  readFrame(timeoutMs) {
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, timer: setTimeout(() => {
        const i = this.waiters.indexOf(waiter); if (i >= 0) this.waiters.splice(i, 1);
        const e = new Error('BSE response timeout'); e.code = 'ETIMEDOUT'; reject(e);
      }, timeoutMs) };
      this.waiters.push(waiter); this.flush();
    });
  }
  write(buffer) { return new Promise((resolve, reject) => this.socket.write(buffer, err => err ? reject(err) : resolve())); }
  destroy() { try { this.socket.destroy(); } catch (_) {} }
}

class BseDropCopyClient extends EventEmitter {
  constructor({ configPath, config, home }) {
    super();
    this.home = home; this.configPath = configPath || null; this.cfg = readIniConfig(config || configPath, home);
    this.socket = null; this.pendingSocket = null; this.cipher = null; this.seq = 1; this.connected = false; this.running = false;
    this.startedAt = 0; this.hbLast = Date.now(); this.hbSent = 0; this.hbRecv = 0;
    this.tradesReceived = 0; this.tradesWritten = 0; this.dataReceived = 0;
    this.noOfPartition = 0; this.partitions = []; this.seenTrades = new Set(); this.instruments = new Map();
    this.dumped10030 = false; this.dumped10500 = false; this.mainHeaders = MAIN_BASIC.concat(this.cfg.verbose ? MAIN_EXT : []);
    this.mainStream = null; this.customStream = null; this.logStream = null; this.logStreams = []; this.logDate = null; this.runPromise = null;
  }
  openDailyLogStream() {
    const now = new Date(Date.now() + IST_OFFSET);
    const day = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-${String(now.getUTCDate()).padStart(2, '0')}`;
    if (this.logStream && this.logDate === day) return;
    if (this.logStream && !this.logStream.writableEnded) this.logStream.end();
    const ext = path.extname(this.cfg.logFile) || '.log';
    const stem = path.basename(this.cfg.logFile, path.extname(this.cfg.logFile));
    const dailyPath = path.join(path.dirname(this.cfg.logFile), `${stem}_${day}${ext}`);
    fs.mkdirSync(path.dirname(dailyPath), { recursive: true });
    this.logStream = fs.createWriteStream(dailyPath, { flags: 'a' });
    this.logStreams.push(this.logStream);
    this.logDate = day;
    this.logStream.on('error', e => this.emit('log', { level: 'ERROR', message: `Log write failed (${dailyPath}): ${e.message}` }));
  }
  log(level, message) {
    const line = `${new Date(Date.now() + IST_OFFSET).toISOString().replace('T', ' ').slice(0, 19)} [${level}] ${message}`;
    this.openDailyLogStream();
    if (this.logStream) this.logStream.write(line + '\n');
    this.emit('log', { level, message: String(message) });
  }
  getStats() {
    return { runtime: this.startedAt ? Math.floor((Date.now() - this.startedAt) / 1000) : 0,
      tradesReceived: this.tradesReceived, tradesWritten: this.tradesWritten,
      heartbeatsSent: this.hbSent, dataReceived: this.dataReceived,
      streamCount: this.partitions.length || this.noOfPartition,
      connected: this.connected, running: this.running };
  }
  async initFiles() {
    for (const item of [[this.cfg.eqdContract, false], [this.cfg.eqScrip, true]]) {
      const [file, equity] = item;
      if (!file || !fs.existsSync(file)) continue;
      try {
        const parsed = csvParse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
        if (!parsed.length) continue;
        const headers = parsed[0]; let added = 0;
        for (const values of parsed.slice(1)) {
          const row = {}; headers.forEach((h, i) => row[h] = values[i] || '');
          const id = String(row.FinInstrmId || '').trim();
          if (!id || (equity && this.instruments.has(id))) continue;
          this.instruments.set(id, {
            TckrSymb: String(row.TckrSymb || '').trim(), XpryDt: equity ? '' : String(row.XpryDt || '').trim(),
            StrkPric: equity ? '' : String(row.StrkPric || '').trim(), OptnTp: equity ? '' : String(row.OptnTp || '').trim(),
            FinInstrmNm: String(row.FinInstrmNm || '').trim()
          }); added++;
        }
        this.log('INFO', `Loaded ${added} ${equity ? 'equity' : 'derivative'} instruments from ${file}`);
      } catch (e) { this.log('WARNING', `Could not load ${file}: ${e.message}`); }
    }
    let priorMainRows = [];
    if (this.cfg.csvMode !== 'overwrite' && fs.existsSync(this.cfg.outputCsv)) {
      try {
        const rows = csvParse(fs.readFileSync(this.cfg.outputCsv, 'utf8'));
        const heads = rows.shift() || [];
        const idIndex = heads.indexOf('SecurityID'), tradeIndex = heads.indexOf('TradeID');
        for (const values of rows) {
          const row = {}; heads.forEach((head, i) => row[head] = values[i] || '');
          if (idIndex >= 0 && tradeIndex >= 0) this.seenTrades.add(`${values[idIndex]}|${values[tradeIndex]}`);
          priorMainRows.push(row);
        }
        if (this.seenTrades.size) this.log('INFO', `Preloaded ${this.seenTrades.size} trades from ${this.cfg.outputCsv}`);
      } catch (e) { this.log('WARNING', `Could not preload trades: ${e.message}`); }
    }
    let restoreCustomCsv = false;
    if (this.cfg.customCsv && this.cfg.csvMode !== 'overwrite') {
      try {
        if (!fs.existsSync(this.cfg.customCsv) || fs.statSync(this.cfg.customCsv).size === 0) restoreCustomCsv = true;
        else restoreCustomCsv = csvParse(fs.readFileSync(this.cfg.customCsv, 'utf8')).length <= 1;
      } catch (e) { this.log('WARNING', `Could not inspect custom CSV ${this.cfg.customCsv}: ${e.message}`); }
    }
    const open = (file, columns) => {
      if (!file) return null;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const exists = this.cfg.csvMode !== 'overwrite' && fs.existsSync(file) && fs.statSync(file).size > 0;
      const stream = fs.createWriteStream(file, { flags: this.cfg.csvMode === 'overwrite' ? 'w' : 'a', encoding: 'utf8' });
      stream.on('error', e => this.log('ERROR', `CSV write failed (${file}): ${e.message}`));
      if (!exists) stream.write(columns.join(this.cfg.delimiter) + '\r\n');
      return stream;
    };
    this.mainStream = open(this.cfg.outputCsv, this.mainHeaders);
    this.customStream = open(this.cfg.customCsv, CUSTOM_COLUMNS);
    if (this.customStream && restoreCustomCsv && priorMainRows.length) {
      for (const row of priorMainRows) {
        const existingTrade = {
          EventType: row.EventType, Date: row.Date, Time: row.Time, SecurityID: row.SecurityID,
          TradeID: row.TradeID, SideTradeID: row.SideTradeID, RootPartyExecutingFirm: row.RootPartyExecutingFirm,
          RootPartyExecutingTraderName: row.RootPartyExecutingTraderName, Side: Number(row.Side), LastQty: row.LastQty,
          LastPx: row.LastPx, ClientCode: row.ClientCode, OrderID: row.OrderID,
          SenderLocationID: row.SenderLocationID, AlgoID: row.AlgoID
        };
        this.writeCsv(this.customStream, CUSTOM_COLUMNS, this.customRow(existingTrade));
      }
      this.log('WARNING', `Restored ${priorMainRows.length} rows into empty custom CSV ${this.cfg.customCsv} from the BSE trade history.`);
    }
  }
  makeFrame(templateId, body, encrypt = false) {
    const header = Buffer.alloc(16); header.writeUInt16LE(templateId, 4);
    let frame = pad8(Buffer.concat([header, body])); frame.writeUInt32LE(frame.length, 0);
    if (encrypt && this.cipher) frame = Buffer.concat([frame.subarray(0, 16), this.cipher.crypt(frame.subarray(16), 'tx')]);
    return frame;
  }
  reqHeader(party = this.cfg.userId) { return Buffer.concat([u32(this.seq), u32(party)]); }
  async send(templateId, body, encrypt = false) {
    await this.socket.write(this.makeFrame(templateId, body, encrypt));
  }
  async recv(decrypt = true, timeout = this.cfg.responseTimeout * 1000) {
    const raw = await this.socket.readFrame(timeout); const tid = raw.readUInt16LE(4);
    let body = raw.subarray(8);
    if (decrypt && this.cipher) body = this.cipher.crypt(body, 'rx');
    this.dataReceived++;
    if (tid === T.REJECT) this.log('WARNING', `<<< REJECT (10010) ${this.decodeReject(tid, body)}`);
    if (tid === T.LOGOUT) this.log('WARNING', `<<< LOGOUT (10012) ${this.decodeReject(tid, body)}`);
    return { tid, body };
  }
  async connectGateway() {
    this.log('INFO', '--- Step 1: Connection Gateway ---'); const started = Date.now();
    const tlsOptions = { host: this.cfg.cgHost, port: this.cfg.cgPort,
      ca: fs.readFileSync(this.cfg.caCert), minVersion: 'TLSv1.3' };
    if (!net.isIP(this.cfg.cgHost)) tlsOptions.servername = this.cfg.cgHost;
    const socket = tls.connect(tlsOptions);
    this.pendingSocket = socket;
    socket.setTimeout(this.cfg.responseTimeout * 1000, () => socket.destroy(new Error('Connection Gateway timeout')));
    await new Promise((resolve, reject) => { socket.once('secureConnect', resolve); socket.once('error', reject); });
    socket.setTimeout(0); this.pendingSocket = null;
    this.socket = new FrameSocket(socket);
    this.log('INFO', `TLS: ${socket.getCipher().name} (${Date.now() - started} ms)`);
    const body = Buffer.concat([u32(this.cfg.sessionId), fixedText(this.cfg.ifaceVersion, 30), fixedText(this.cfg.password, 32), Buffer.alloc(6)]);
    const payload = Buffer.concat([Buffer.alloc(16), u32(1), u32(0), body]);
    const framed = pad8(payload); framed.writeUInt32LE(framed.length, 0); framed.writeUInt16LE(T.CONN_GW_REQ, 4);
    await this.socket.write(framed);
    const raw = await this.socket.readFrame(this.cfg.responseTimeout * 1000);
    const tid = raw.readUInt16LE(4); const response = raw.subarray(8);
    if (tid !== T.CONN_GW_RSP) throw new Error(`Expected 10022, got ${tid}`);
    let off = 24;
    const gw = [response.readUInt32LE(off), response.readUInt32LE(off + 4), response.readUInt32LE(off + 8), response.readUInt32LE(off + 12)]; off += 16;
    const sessionMode = response[off++], tradMode = response[off++];
    const key = response.subarray(off, off + 32); off += 32; const iv = response.subarray(off, off + 16);
    this.log('INFO', `Primary GW   ${ipString(gw[0])}:${gw[1]}`); this.log('INFO', `Secondary GW ${ipString(gw[2])}:${gw[3]}`);
    this.log('INFO', `SessionMode=${sessionMode} (${sessionMode === 1 ? 'HF' : sessionMode === 2 ? 'LF' : '?'}) TradSesMode=${tradMode}`);
    this.cipher = new BseCipher(key, iv); this.socket.destroy(); this.socket = null;
    return [ipString(gw[0]), gw[1], ipString(gw[2]), gw[3]];
  }
  async connectApp(host, port) {
    this.log('INFO', '--- Step 2: App Gateway + Session Registration ---');
    const socket = net.createConnection({ host, port });
    this.pendingSocket = socket;
    socket.setTimeout(this.cfg.responseTimeout * 1000, () => socket.destroy(new Error('App Gateway connection timeout')));
    await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
    socket.setTimeout(0); this.pendingSocket = null;
    this.socket = new FrameSocket(socket); this.seq = 1;
    const body = Buffer.concat([u32(this.cfg.sessionId), Buffer.alloc(12)]);
    await this.socket.write(this.makeFrame(T.SESSION_REG_REQ, Buffer.concat([this.reqHeader(0), body]))); this.seq++;
    const { tid, body: response } = await this.recv(false);
    if (tid !== T.SESSION_REG_RSP) throw new Error(`Expected 10054, got ${tid}`);
    if (response.subarray(24, 25).toString() !== 'Y') throw new Error(`Registration rejected: ${response.subarray(24).toString('hex')}`);
    this.log('INFO', 'Session Registration accepted.');
  }
  async sessionLogon() {
    this.log('INFO', '--- Step 3: Session Logon ---');
    const body = Buffer.concat([u32(this.cfg.heartbeatSec * 1000), u32(this.cfg.sessionId), fixedText(this.cfg.ifaceVersion, 30), fixedText(this.cfg.password, 32), Buffer.from('NNN'),
      fixedText('DropCopyPy', 30), fixedText('DropCopyPy', 30), fixedText('1.0', 30), fixedText('1.0', 30), fixedText('Custom', 30), fixedText('Custom', 30), Buffer.alloc(3)]);
    await this.send(T.SESSION_LOGON, Buffer.concat([this.reqHeader(0), body]), true); this.seq++;
    const { tid, body: response } = await this.recv();
    if (tid !== T.SESSION_LOGON_RSP) throw new Error(`Session Logon failed: tid=${tid} ${this.decodeReject(tid, response)}`);
    try {
      const throttle = response.readInt32LE(24), messages = response.readUInt32LE(40), disc = response.readUInt32LE(44), hb = response.readUInt32LE(48);
      this.noOfPartition = response[57]; this.log('INFO', `Session Logon OK  hb=${hb}ms  throttle=${messages}/${throttle}ms  disc=${disc}  NoOfPartition=${this.noOfPartition}`);
    } catch (_) { this.log('INFO', 'Session Logon OK'); }
  }
  async userLogon() {
    this.log('INFO', '--- Step 4: User Logon ---');
    await this.send(T.USER_LOGON, Buffer.concat([this.reqHeader(), u32(this.cfg.userId), fixedText(this.cfg.password, 32), Buffer.alloc(4)]), true); this.seq++;
    const { tid, body } = await this.recv();
    if (tid !== T.USER_LOGON_RSP) throw new Error(`User Logon failed: tid=${tid} ${this.decodeReject(tid, body)}`);
    this.log('INFO', 'User Logon OK');
  }
  async subscribe(scope, refApplId) {
    const body = Buffer.concat([u32(scope), Buffer.from([refApplId & 255, 0, 0, 0])]);
    await this.send(T.SUBSCRIBE, Buffer.concat([this.reqHeader(), body]), true); this.seq++;
    const { tid, body: response } = await this.recv();
    if (tid !== T.SUBSCRIBE_RSP) throw new Error(`Subscribe(RefApplID=${refApplId}) failed: tid=${tid} ${this.decodeReject(tid, response)}`);
    return response.readUInt32LE(0);
  }
  async subscribeTrade() { const id = await this.subscribe(0xffffffff, this.cfg.refApplId); this.log('INFO', `Trade subscription active. ApplSubID=${id}`); }
  async sessionList() {
    this.log('INFO', '--- Session List Inquire (10035) ---');
    await this.send(T.SESSION_LIST_REQ, this.reqHeader(), true); this.seq++;
    let got; try { got = await this.recv(true, this.cfg.responseTimeout * 1000); } catch (e) { if (e.code === 'ETIMEDOUT') { this.log('WARNING', 'Session List Inquire timeout'); return []; } throw e; }
    if (got.tid !== T.SESSION_LIST_RSP || got.body.length < 32) { this.log('WARNING', `Session List Inquire: unexpected tid=${got.tid}`); return []; }
    const n = got.body.readUInt16LE(24), sessions = []; let off = 32;
    for (let i = 0; i < n && off + 8 <= got.body.length; i++, off += 8) sessions.push([got.body.readUInt32LE(off), got.body[off + 4], got.body[off + 5]]);
    this.log('INFO', `Found ${sessions.length} sessions`); sessions.forEach(s => this.log('DEBUG', `  Session ${s[0]}  (Mode=${s[1]} SubMode=${s[2]})`));
    return sessions;
  }
  async discoverPartitions() {
    this.log('INFO', '--- Service Availability discovery (10030) ---');
    try { await this.subscribe(0xffffffff, 3); } catch (e) { this.log('WARNING', `SA subscribe failed: ${e.message}`); return []; }
    const parts = [], deadline = Date.now() + 60000;
    while (Date.now() < deadline && this.running) {
      let msg; try { msg = await this.recv(true, 2000); } catch (e) { if (e.code === 'ETIMEDOUT') continue; throw e; }
      if (msg.tid === T.SERVICE_AVAIL) {
        if (!this.dumped10030) { this.dumped10030 = true; this.dumpRaw('10030', msg.body); }
        if (msg.body.length >= 33) {
          const pid = msg.body.readUInt16LE(28);
          if (!parts.includes(pid)) { parts.push(pid); this.log('INFO', `  Partition ${pid}  (Matching=${msg.body[30]} TradeMgr=${msg.body[31]} ApplSeq=${msg.body[32]})`); }
          if (this.noOfPartition && parts.length >= this.noOfPartition) break;
        }
      } else if (msg.tid === T.HEARTBEAT_NTF) { this.hbRecv++; this.emit('heartbeat', { direction: 'received' }); }
      else if (msg.tid === T.REJECT || msg.tid === T.LOGOUT) break;
    }
    this.partitions = parts.sort((a, b) => a - b); this.log('INFO', `Discovered ${parts.length} partition(s): ${JSON.stringify(this.partitions)}`); return this.partitions;
  }
  dumpRaw(label, body) { this.log('DEBUG', `${label} raw (len=${body.length}):`); for (let i = 0; i < body.length; i += 16) this.log('DEBUG', `  [${String(i).padStart(2, '0')}] ${[...body.subarray(i, i + 16)].map(b => b.toString(16).padStart(2, '0')).join(' ')}`); }
  decodeReject(tid, body) {
    try {
      if (tid === T.LOGOUT) { const n = body.readUInt16LE(8); return !n || n > 200 ? '(no text)' : `text=${body.subarray(16, 16 + n).toString('latin1').replace(/\0+$/, '')}`; }
      if (body.length < 64) return `(short: ${body.length}B)`;
      const code = body.readUInt32LE(48), n = body.readUInt16LE(52);
      return !n || n > 200 ? `reason=${code} (no text)` : `reason=${code}, text=${body.subarray(56, 56 + n).toString('latin1').replace(/\0+$/, '')}`;
    } catch (e) { return `(decode error: ${e.message})`; }
  }
  async retransmitOne(sessionId, partitionId) {
    let total = 0, begin = this.cfg.retransmitBegin > 0 ? this.cfg.retransmitBegin : 1, lastEnd = null;
    for (let iteration = 0; iteration < 500 && this.running; iteration++) {
      this.log('INFO', `  -> Session ${sessionId}, Partition ${partitionId}: retransmit beg=${begin}`);
      const body = Buffer.concat([u64(begin), u64(NO.U64), u32(sessionId), u16(partitionId), Buffer.from([this.cfg.refApplId & 255, 0])]);
      await this.send(T.RETRANSMIT, Buffer.concat([this.reqHeader(), body]), true); this.seq++;
      let msg; try { msg = await this.recv(true, this.cfg.retransmitTimeout * 1000); } catch (e) { if (e.code === 'ETIMEDOUT') return total; throw e; }
      if (msg.tid !== T.RETRANSMIT_RSP) { const reason = this.decodeReject(msg.tid, msg.body); this.log('WARNING', `  -> expected 10009 got ${msg.tid} ${reason}`); return msg.tid === T.REJECT && reason.toLowerCase().includes('invalid') ? -1 : total; }
      if (msg.body.length < 48) return total;
      const appEnd = msg.body.readBigUInt64LE(24), refLast = msg.body.readBigUInt64LE(32), count = msg.body.readUInt32LE(40);
      if (!count || refLast === NO.U64) { this.log('INFO', `  -> no messages (last_seq=${refLast === NO.U64 ? 'no value' : refLast})`); break; }
      this.log('INFO', `  -> batch ${iteration + 1}  ${count} msgs (end=${appEnd} last=${refLast})`);
      let received = 0, trades = 0;
      while (received < count && this.running) {
        let next; try { next = await this.recv(true, this.cfg.retransmitTimeout * 1000); } catch (e) { if (e.code === 'ETIMEDOUT') break; throw e; }
        received++;
        if (next.tid === T.TRADE) { this.handleTrade(next.body); trades++; }
        else if (next.tid === T.HEARTBEAT_NTF) { this.hbRecv++; this.emit('heartbeat', { direction: 'received' }); }
        else if (next.tid === T.LOGOUT) return total;
      }
      total += trades;
      if (appEnd === refLast || appEnd === 0n) break;
      if (lastEnd !== null && appEnd === lastEnd) break;
      lastEnd = appEnd; begin = Number(appEnd + 1n);
      if (this.cfg.retransmitPause > 0) await delay(this.cfg.retransmitPause * 1000);
    }
    return total;
  }
  parsePartitionRange(spec) {
    const parts = new Set();
    for (const chunk of String(spec).split(',')) { const s = chunk.trim(); if (!s) continue; const m = s.match(/^(\d+)\s*-\s*(\d+)$/); if (m) for (let i = Number(m[1]); i <= Number(m[2]); i++) parts.add(i); else parts.add(Number(s)); }
    return [...parts].sort((a, b) => a - b);
  }
  async retransmit() {
    this.log('INFO', '--- Step 5b: Retransmit scan ---');
    let sessions = await this.sessionList(); if (!sessions.length) { this.log('WARNING', 'No sessions; retransmit skipped'); return; }
    if (this.cfg.prioritySessions) {
      const want = new Set(this.cfg.prioritySessions.split(',').map(x => Number(x.trim())).filter(Number.isFinite));
      sessions = sessions.filter(s => want.has(s[0])); this.log('INFO', `Priority sessions: ${JSON.stringify(sessions.map(s => s[0]))}`);
    }
    let partitions = await this.discoverPartitions(); if (!partitions.length) { this.log('WARNING', 'No partitions from exchange; retransmit skipped'); return; }
    const whitelist = this.cfg.partitionWhitelist.toLowerCase();
    if (!['0xffffffff', 'all', ''].includes(whitelist)) partitions = partitions.filter(p => this.parsePartitionRange(whitelist).includes(p));
    const retransmitRange = String(this.cfg.retransmitPartitions || '').trim().toLowerCase();
    if (!['', 'all', '0xffffffff'].includes(retransmitRange)) {
      const allowedPartitions = new Set(this.parsePartitionRange(retransmitRange));
      partitions = partitions.filter(partition => allowedPartitions.has(partition));
      this.log('INFO', `Retransmit partition range ${retransmitRange}: ${partitions.length} partition(s) selected`);
    }
    if (!partitions.length) { this.log('WARNING', 'No discovered partitions match the configured retransmit range'); return; }
    let total = 0;
    for (const [sid, mode, submode] of sessions) {
      this.log('INFO', `=== Session ${sid} (Mode=${mode} SubMode=${submode}) ===`); let sessionTotal = 0;
      for (const pid of partitions) { try { const n = await this.retransmitOne(sid, pid); if (n === -1) break; sessionTotal += n; } catch (e) { this.log('WARNING', `Session ${sid}, Partition ${pid}: ${e.message}`); break; } }
      total += sessionTotal; this.log('INFO', `Session ${sid}: ${sessionTotal} trades`);
    }
    this.log('INFO', `--- Retransmit complete: ${total} trades ---`);
  }
  async heartbeat() {
    const hb = Buffer.alloc(16); hb.writeUInt32LE(16, 0); hb.writeUInt16LE(T.HEARTBEAT, 4);
    await this.socket.write(hb); this.hbLast = Date.now(); this.hbSent++;
    this.emit('heartbeat', { direction: 'sent' });
    this.log('INFO', `Heartbeat sent  (#${this.hbSent}, every ${this.cfg.heartbeatSec}s)`);
  }
  async run() {
    this.running = true; this.startedAt = Date.now();
    this.log('INFO', 'BSE ETI Drop Copy starting (IST)');
    this.log('INFO', `  CG           = ${this.cfg.cgHost}:${this.cfg.cgPort}`);
    this.log('INFO', `  SessionID    = ${this.cfg.sessionId}`); this.log('INFO', `  UserID       = ${this.cfg.userId}`);
    this.log('INFO', `  MemberID     = ${this.cfg.memberId}`); this.log('INFO', `  Interface    = ${this.cfg.ifaceVersion}`);
    this.log('INFO', `  RefApplID    = ${this.cfg.refApplId}`); this.log('INFO', `  Heartbeat    = ${this.cfg.heartbeatSec}s`);
    this.log('INFO', `  Output CSV   = ${this.cfg.outputCsv} (mode=${this.cfg.csvMode})`);
    this.log('INFO', `  Custom CSV   = ${this.cfg.customCsv || '(disabled)'}`);
    try {
      if (!this.cfg.cgHost || !this.cfg.cgPort) throw new Error('BSE connection host and port are required.');
      await this.initFiles();
      const [gw, port, secondary, secondaryPort] = await this.connectGateway();
      try { await this.connectApp(gw, port); }
      catch (e) { this.log('WARNING', `Primary GW failed (${e.message}), trying secondary`); if (this.socket) this.socket.destroy(); this.socket = null; await this.connectApp(secondary, secondaryPort); }
      await this.sessionLogon(); await this.userLogon(); await this.subscribeTrade();
      if (this.cfg.retransmitEnabled) await this.retransmit();
      else this.log('WARNING', 'Historical retransmission is disabled. Set [RETRANSMIT] enabled = true to request saved trades.');
      this.connected = true; this.emit('status', { connected: true, running: true });
      this.log('INFO', '--- Step 6: Receive loop ---');
      while (this.running && this.socket) {
        if (Date.now() - this.hbLast > this.cfg.heartbeatSec * this.cfg.heartbeatMargin * 1000) await this.heartbeat();
        let msg; try { msg = await this.recv(true, 1000); } catch (e) { if (e.code === 'ETIMEDOUT') continue; if (!this.running) break; throw e; }
        if (msg.tid === T.TRADE) this.handleTrade(msg.body);
        else if (msg.tid === T.END_TRADE) { this.log('INFO', 'End of Trade stream. Stopping.'); break; }
        else if (msg.tid === T.HEARTBEAT_NTF) { this.hbRecv++; this.emit('heartbeat', { direction: 'received' }); this.log('INFO', `Heartbeat notification received (sent=${this.hbSent} recv=${this.hbRecv})`); }
        else if (msg.tid === T.LOGOUT) { this.log('WARNING', 'Session logout from exchange. Exiting.'); break; }
      }
    } catch (e) { if (this.running) { this.log('ERROR', `Fatal: ${e.stack || e.message}`); this.emit('error', e); } }
    finally {
      this.running = false; this.connected = false; if (this.socket) this.socket.destroy(); this.socket = null;
      await Promise.all([this.mainStream, this.customStream, ...this.logStreams].filter(Boolean).map(stream => new Promise(resolve => {
        if (stream.writableFinished || stream.destroyed) return resolve();
        let finished = false;
        const done = () => { if (finished) return; finished = true; resolve(); };
        stream.once('finish', done); stream.once('close', done); stream.once('error', done);
        stream.end();
      })));
      this.emit('status', { connected: false, running: false }); this.emit('stats', this.getStats());
      this.logStream = null; this.logStreams = []; this.logDate = null;
    }
  }
  stop() { this.running = false; this.connected = false; if (this.pendingSocket) this.pendingSocket.destroy(); if (this.socket) this.socket.destroy(); return this.runPromise || Promise.resolve(); }
  handleTrade(body) {
    try {
      if (!this.dumped10500) { this.dumped10500 = true; this.dumpRaw('10500', body); }
      const trade = this.parseTrade(body), key = `${trade.SecurityID}|${trade.TradeID}`;
      this.tradesReceived++;
      if (this.seenTrades.has(key)) return;
      this.seenTrades.add(key); this.tradesWritten++;
      this.writeCsv(this.mainStream, this.mainHeaders, trade);
      const custom = this.customRow(trade); if (this.customStream) this.writeCsv(this.customStream, CUSTOM_COLUMNS, custom);
      this.emit('trade', custom); this.emit('stats', this.getStats());
      if (this.tradesWritten % 100 === 0) this.log('INFO', `Wrote ${this.tradesWritten} unique trades`);
    } catch (e) { this.log('ERROR', `Trade parse failed: ${e.stack || e.message}`); }
  }
  writeCsv(stream, columns, row) { if (stream) stream.write(columns.map(k => csvEscape(row[k])).join(this.cfg.delimiter) + '\r\n'); }
  parseTrade(body) {
    let off = 32;
    const read = (size, type) => {
      if (off + size > body.length) throw new Error(`Trade message truncated at byte ${off}`);
      const p = off; off += size;
      if (type === 'i8') return body.readInt8(p); if (type === 'u8') return body.readUInt8(p);
      if (type === 'i16') return body.readInt16LE(p); if (type === 'u16') return body.readUInt16LE(p);
      if (type === 'i32') return body.readInt32LE(p); if (type === 'u32') return body.readUInt32LE(p);
      if (type === 'i64') return body.readBigInt64LE(p); if (type === 'u64') return body.readBigUInt64LE(p);
    };
    const str = n => { if (off + n > body.length) throw new Error(`Trade string truncated at byte ${off}`); const s = body.subarray(off, off + n).toString('latin1').replace(/\0+$/, ''); off += n; return s; };
    const securityId=read(8,'i64'), relatedSecurityId=read(8,'i64'), price=read(8,'i64'), lastPx=read(8,'i64'), sideLastPx=read(8,'i64'), clearingTradePrice=read(8,'i64'), yieldVal=read(8,'i64'), underlyingDirtyPrice=read(8,'i64');
    const transactTime=read(8,'u64'), orderId=read(8,'u64'), senderLocationId=read(8,'u64'), ciOrdId=read(8,'u64'), activityTime=read(8,'u64');
    read(8,'u64'); read(4,'u32'); const messageTag=read(4,'i32'), tradeId=read(4,'u32'), origTradeId=read(4,'u32'), execUnit=read(4,'u32'), sessionId=read(4,'u32'), execTrader=read(4,'u32');
    read(4,'u32'); const cumQty=read(4,'i32'), leavesQty=read(4,'i32'), marketSegment=read(4,'i32'), relatedSymbol=read(4,'i32'), lastQty=read(4,'i32'), sideLastQty=read(4,'i32'), clearingQty=read(4,'i32');
    const sideTradeId=read(4,'u32'), matchDate=read(4,'u32'), matchId=read(4,'u32'), strategyLink=read(4,'u32'), totalReports=read(4,'i32');
    read(2,'u16'); const multiLeg=read(1,'u8'), reportType=read(1,'u8'), transferReason=read(1,'u8'), rollover=read(1,'u8');
    str(9); str(5); str(7); const accountType=read(1,'u8'), matchType=read(1,'u8'), matchSubType=read(1,'u8'), side=read(1,'u8'), aggressor=read(1,'u8'), capacity=read(1,'u8');
    off += 2; const positionEffect=read(1,'u8'), orderHandling=read(1,'u8'), algoId=str(16), clientCode=str(12), cpCode=str(12), freeText3=str(12);
    const orderCategory=read(1,'u8'), orderType=read(1,'u8'), relatedProduct=read(1,'u8'), orderSide=read(1,'u8');
    str(4); const executingFirm=str(5), executingName=str(6); str(5);
    const [date, time] = istParts(transactTime), [dateRecv, timeRecv] = nowIst(), [dateAct, timeAct] = istParts(activityTime);
    return {
      EventType: origTradeId !== 0 && origTradeId !== NO.U32 ? 'CANCEL' : 'TRADE', Date: date, Time: time, Date_Recv: dateRecv, Time_Recv: timeRecv,
      SecurityID: clean64(securityId), MarketSegmentID: clean32(marketSegment), LastPx: price8(lastPx), LastQty: clean32(lastQty), Side: cleanU8(side),
      OrderID: cleanU64(orderId), CIOrdID: cleanU64(ciOrdId), TradeID: cleanU32(tradeId), OrigTradeID: cleanU32(origTradeId), SideTradeID: cleanU32(sideTradeId), TrdMatchID: cleanU32(matchId),
      RootPartyIDExecutingUnit: cleanU32(execUnit), RootPartyIDSessionID: cleanU32(sessionId), RootPartyIDExecutingTrader: cleanU32(execTrader), CumQty: clean32(cumQty), LeavesQty: clean32(leavesQty),
      ClearingTradeQty: clean32(clearingQty), AccountType: cleanU8(accountType), MatchDate: cleanU32(matchDate), Price: price8(price), RelatedSecurityID: clean64(relatedSecurityId),
      SideLastPx: price8(sideLastPx), SideLastQty: clean32(sideLastQty), ClearingTradePrice: price8(clearingTradePrice), Yield: price8(yieldVal), UnderlyingDirtyPrice: price8(underlyingDirtyPrice),
      Date_Act: dateAct, Time_Act: timeAct, SenderLocationID: cleanU64(senderLocationId), MessageTag: messageTag, RelatedSymbol: clean32(relatedSymbol), StrategyLinkID: cleanU32(strategyLink),
      TotNumTradeReports: clean32(totalReports), MultiLegReportingType: cleanU8(multiLeg), TradeReportType: cleanU8(reportType), TransferReason: cleanU8(transferReason), RolloverFlag: cleanU8(rollover),
      MatchType: cleanU8(matchType), MatchSubType: cleanU8(matchSubType), AggressorIndicator: cleanU8(aggressor), TradingCapacity: cleanU8(capacity), PositionEffect: cleanU8(positionEffect),
      CustOrderHandlingInst: cleanU8(orderHandling), AlgoID: algoId, ClientCode: clientCode, CPCode: cpCode, FreeText3: freeText3, OrderCategory: cleanU8(orderCategory), OrdType: cleanU8(orderType),
      RelatedProductComplex: cleanU8(relatedProduct), OrderSide: cleanU8(orderSide), RootPartyExecutingFirm: executingFirm, RootPartyExecutingTraderName: executingName
    };
  }
  customRow(t) {
    const inst = this.instruments.get(String(t.SecurityID)) || {};
    return { member_id: String(t.RootPartyExecutingFirm || '').trim(), trader_id: String(t.RootPartyExecutingTraderName || '').replace(/^T/, ''),
      instrument: inst.FinInstrmNm || '', token: t.SecurityID, symbol: inst.TckrSymb || '', expiry_date: inst.XpryDt || '', strike_price: strikeRupees(inst.StrkPric),
      option_type: inst.OptnTp || '', buy_sell: ({ 1: 'BUY', 2: 'SELL' })[t.Side] || '', ex_qty: t.LastQty, ex_price: price2(t.LastPx),
      clnt_id: String(t.ClientCode || '').trim(), order_no: t.OrderID, trade_no: t.SideTradeID, pan: '', nnf: t.SenderLocationID,
      timestamp: `${t.Date} ${t.Time}`.trim(), time: t.Time, trade_status: t.EventType, algo_id: t.AlgoID };
  }
  async close() { this.stop(); }
}

function ipString(n) { return [24, 16, 8, 0].map(s => (n >>> s) & 255).join('.'); }
function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

module.exports = { BseDropCopyClient };
