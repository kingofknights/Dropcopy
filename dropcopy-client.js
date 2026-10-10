#!/usr/bin/env node
'use strict';

const net = require('net');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const ini = require('ini');

// ============================================================================
// Constants
// ============================================================================

const TransactionCode = Object.freeze({
    SIGN_ON_REQUEST_IN: 2300,
    SIGN_ON_REQUEST_OUT: 2301,
    TRADE_CONFIRMATION: 2222,
    TRADE_MODIFY_CONFIRM: 2287,
    TRADE_MODIFY_REJECT: 2288,
    TRADE_CANCEL_CONFIRM: 2282,
    TRADE_CANCEL_REJECT: 2286,
    GIVEUP_APP_CONFIRM_TM: 4506,
    GIVEUP_REJ_CONFIRM_TM: 4507,
    HEARTBEAT: 23506,
    DC_DOWNLOAD_REQUEST: 8000
});

// NSE epoch: 1980-01-01 00:00:00 IST  ==  1979-12-31 18:30:00 UTC
const NSE_EPOCH_MS = Date.UTC(1979, 11, 31, 18, 30, 0);
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

// ============================================================================
// Utilities
// ============================================================================

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Seconds since 1980 → "HH:MM:SS" (IST time-of-day)
function formatNseTimeOnly(sec) {
    try {
        if (!sec || typeof sec !== 'number' || !isFinite(sec) || sec <= 0) return '';
        const secsInDay = Math.floor(sec) % 86400;
        const hh = String(Math.floor(secsInDay / 3600)).padStart(2, '0');
        const mm = String(Math.floor((secsInDay % 3600) / 60)).padStart(2, '0');
        const ss = String(secsInDay % 60).padStart(2, '0');
        return hh + ':' + mm + ':' + ss;
    } catch (e) { return ''; }
}

// Nanoseconds since 1980-01-01 00:00:00 IST → "YYYY-MM-DD HH:MM:SS.mmm" in IST
function formatTradeTimestamp(nseNs) {
    try {
        if (!nseNs || nseNs === '0') return '';
        const ms = NSE_EPOCH_MS + Number(BigInt(nseNs) / 1000000n) + IST_OFFSET_MS;
        const d = new Date(ms);
        if (isNaN(d.getTime())) return '';

        const yyyy = d.getUTCFullYear();
        const mo   = String(d.getUTCMonth() + 1).padStart(2, '0');
        const dd   = String(d.getUTCDate()).padStart(2, '0');
        const hh   = String(d.getUTCHours()).padStart(2, '0');
        const mm   = String(d.getUTCMinutes()).padStart(2, '0');
        const ss   = String(d.getUTCSeconds()).padStart(2, '0');
        const ms3  = String(d.getUTCMilliseconds()).padStart(3, '0');

        return yyyy + '-' + mo + '-' + dd + ' ' + hh + ':' + mm + ':' + ss + '.' + ms3;
    } catch (e) { return ''; }
}

// ExpiryDate → "YYYY Mon DD" e.g. "2026 Sep 25"
function formatExpiryDate(val) {
    if (!val) return '';
    let d = null;
    if (Number.isInteger(val) && val >= 19000101 && val <= 99991231) {
        const s = String(val);
        d = new Date(Date.UTC(
            parseInt(s.substring(0, 4), 10),
            parseInt(s.substring(4, 6), 10) - 1,
            parseInt(s.substring(6, 8), 10)
        ));
    } else if (typeof val === 'number' && isFinite(val)) {
        d = new Date(NSE_EPOCH_MS + val * 1000);
    }
    if (!d || isNaN(d.getTime())) return '';
    const months = ['Jan','Feb','Mar','Apr','May','Jun',
                    'Jul','Aug','Sep','Oct','Nov','Dec'];
    return d.getUTCFullYear() + ' ' + months[d.getUTCMonth()] + ' ' +
           String(d.getUTCDate()).padStart(2, '0');
}

function dateToNseSeconds(date) {
    return Math.floor((date.getTime() - NSE_EPOCH_MS) / 1000);
}

function nowNseSeconds() {
    return Math.floor((Date.now() - NSE_EPOCH_MS) / 1000);
}

function todayMarketOpenIST() {
    const now = new Date();
    const istMs = now.getTime() + IST_OFFSET_MS + (now.getTimezoneOffset() * 60000);
    const ist = new Date(istMs);
    return new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate(), 3, 45, 0));
}

function formatPrice(p) {
    try { return p ? (p / 100).toFixed(2) : '0.00'; } catch (e) { return '0.00'; }
}

function cleanString(data, length) {
    if (!data) return '';
    try {
        let r = data.slice(0, length).toString('ascii').replace(/\x00/g, '').trim();
        return r.split('').filter(c => {
            const n = c.charCodeAt(0);
            return (n >= 32 && n <= 126) || c === ' ';
        }).join('');
    } catch (e) { return ''; }
}

// ONLY strip a leading 'X' marker. Preserve all other letters.
function stripXPrefix(s) {
    if (!s) return '';
    if (s.charAt(0) === 'X' && s.length >= 5) {
        const rest = s.slice(1);
        if (/^[A-Z0-9&\-]+$/.test(rest)) return rest;
    }
    return s;
}

// TradeStatus — return original NSE transaction name as-is
function eventTypeToStatus(eventType) {
    return eventType || '';
}

// Read a DOUBLE that holds a large integer (like an order number).
// NSE packs the order number into an 8-byte IEEE-754 double.
// readBigUInt64BE gives the raw bit pattern — wrong.
// readDoubleBE gives the numeric value, but tiny float rounding can nudge it.
// Math.round cleans it to the exact integer, then String() gives plain digits.
function readPackedDoubleAsString(buf, offset) {
    try {
        const d = buf.readDoubleBE(offset);
        if (!isFinite(d)) return '0';
        return String(Math.round(d));
    } catch (e) { return '0'; }
}

// ---------------------------------------------------------------------------
// tradeToRow
// ---------------------------------------------------------------------------
function tradeToRow(trade) {
    const cd = trade.contractDesc || {};
    const buySellMap = { 1: 'BUY', 2: 'SELL' };

    const memberId = cleanString(trade.brokerId, 5);
    const symbol = stripXPrefix(cleanString(cd.symbol, 10));
    const instrument = cleanString(cd.instrumentName, 6);
    const optionType = cleanString(cd.optionType, 2);
    const clntId = cleanString(trade.accountNum, 10);
    const pan = cleanString(trade.pan, 10);

    // NNF — raw value, no formatting, no rupee conversion
    let nnf = '';
    try {
        if (typeof trade.nnfField === 'number' && isFinite(trade.nnfField)) {
            nnf = String(trade.nnfField);
        }
    } catch (e) { nnf = ''; }

    // StrikePrice — 0.00 for futures, real value for options
    let strikePrice = '0.00';
    if (instrument.indexOf('FUT') === 0) {
        strikePrice = '0.00';
    } else {
        strikePrice = formatPrice(cd.strikePrice);
    }

    return {
        member_id:      memberId,
        trader_id:      trade.traderNum,
        instrument:     instrument,
        token:          trade.token,
        symbol:         symbol,
        expiry_date:    formatExpiryDate(cd.expiryDate),
        strike_price:   strikePrice,
        option_type:    optionType,
        buy_sell:       buySellMap[trade.buySell] || '',
        ex_qty:         trade.fillQty,
        ex_price:       formatPrice(trade.fillPrice),
        clnt_id:        clntId,
        // Order number — comes out as clean digits now
        order_no:       trade.responseOrderNumber,
        trade_no:       trade.fillNumber,
        pan:            pan,
        nnf:            nnf,
        // Nanoseconds since 1980 → "YYYY-MM-DD HH:MM:SS.mmm" in IST
        timestamp:      formatTradeTimestamp(trade.header ? trade.header.timestamp : '0'),
        time:           formatNseTimeOnly(trade.activityTime),
        trade_status:   eventTypeToStatus(trade.eventType),
        algo_id:        trade.algoId,

        _processed_time: trade.processedTime,
        _event_type:     trade.eventType,
        _book_type:      trade.bookType,
        _open_close:     trade.openClose && trade.openClose < 256 ? String.fromCharCode(trade.openClose) : '',
        _orig_vol:       trade.originalVol,
        _rem_vol:        trade.remainingVol,
        _broker_id:      cleanString(trade.brokerId, 5),
        _counter_broker: cleanString(trade.opBrokerId, 5),
        _counter_order:  trade.opOrderNumber
    };
}

// ============================================================================
// Logger
// ============================================================================

class Logger {
    constructor(logFile, logLevel, maxBytes, backupCount) {
        this.logFile = logFile;
        this.logDir = logFile ? path.dirname(logFile) : null;
        this.logStem = logFile ? path.basename(logFile, path.extname(logFile)) : null;
        this.logExt = logFile ? (path.extname(logFile) || '.log') : null;
        this.activeLogDate = null;
        this.logLevel = logLevel || 'INFO';
        this.maxBytes = maxBytes || 10485760;
        this.backupCount = backupCount || 5;
        this.levels = { DEBUG: 0, INFO: 1, WARNING: 2, ERROR: 3 };
        this._listeners = [];
        if (logFile) {
            const dir = path.dirname(logFile);
            if (dir && dir !== '.' && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        }
    }
    onLog(cb) { this._listeners.push(cb); }
    _dailyLogFile(date) {
        const istDate = new Date(date.getTime() + IST_OFFSET_MS + (date.getTimezoneOffset() * 60000));
        const day = `${istDate.getUTCFullYear()}-${String(istDate.getUTCMonth() + 1).padStart(2, '0')}-${String(istDate.getUTCDate()).padStart(2, '0')}`;
        return path.join(this.logDir, `${this.logStem}_${day}${this.logExt}`);
    }
    _write(level, message) {
        if (this.levels[level] < this.levels[this.logLevel]) return;
        const ts = new Date().toISOString().replace('T', ' ').substring(0, 23);
        const line = ts + ' - ' + level + ' - ' + message + '\n';
        process.stdout.write(line);
        if (this.logFile) {
            try {
                const now = new Date();
                const dailyFile = this._dailyLogFile(now);
                fs.appendFileSync(dailyFile, line);
            }
            catch (e) { process.stderr.write('Log write error: ' + e.message + '\n'); }
        }
        for (const cb of this._listeners) { try { cb(level, message); } catch (e) {} }
    }
    debug(m) { this._write('DEBUG', m); }
    info(m) { this._write('INFO', m); }
    warning(m) { this._write('WARNING', m); }
    error(m) { this._write('ERROR', m); }
}

// ============================================================================
// Protocol Data Structures
// ============================================================================

class MessageHeader {
    constructor(data) {
        data = data || {};
        this.transactionCode = data.transactionCode || 0;
        this.logTime = data.logTime || 0;
        this.alphaChar = data.alphaChar || Buffer.from('  ');
        this.userId = data.userId || 0;
        this.errorCode = data.errorCode || 0;
        this.timestamp = data.timestamp !== undefined ? String(data.timestamp) : '0';
        this.timestamp1 = data.timestamp1 || Buffer.alloc(8);
        this.timestamp2 = data.timestamp2 || Buffer.alloc(8);
        this.messageLength = data.messageLength || 0;
    }
    pack() {
        const buf = Buffer.alloc(40);
        let o = 0;
        buf.writeUInt16BE(this.transactionCode, o); o += 2;
        buf.writeUInt32BE(this.logTime, o); o += 4;
        this.alphaChar.copy(buf, o, 0, 2); o += 2;
        buf.writeUInt32BE(this.userId, o); o += 4;
        buf.writeUInt16BE(this.errorCode, o); o += 2;
        buf.writeBigUInt64BE(BigInt(this.timestamp), o); o += 8;
        this.timestamp1.copy(buf, o, 0, 8); o += 8;
        this.timestamp2.copy(buf, o, 0, 8); o += 8;
        buf.writeUInt16BE(this.messageLength, o);
        return buf;
    }
    static unpack(data) {
        const h = new MessageHeader();
        let o = 0;
        h.transactionCode = data.readUInt16BE(o); o += 2;
        h.logTime = data.readUInt32BE(o); o += 4;
        h.alphaChar = Buffer.from(data.slice(o, o + 2)); o += 2;
        h.userId = data.readUInt32BE(o); o += 4;
        h.errorCode = data.readUInt16BE(o); o += 2;
        // timestamp = nanoseconds since 1980 — 64-bit unsigned integer
        h.timestamp = data.readBigUInt64BE(o).toString(); o += 8;
        h.timestamp1 = Buffer.from(data.slice(o, o + 8)); o += 8;
        h.timestamp2 = Buffer.from(data.slice(o, o + 8)); o += 8;
        h.messageLength = data.readUInt16BE(o);
        return h;
    }
}

class ContractInfo {
    constructor(data) {
        data = data || {};
        this.instrumentName = data.instrumentName || Buffer.alloc(6);
        this.symbol = data.symbol || Buffer.alloc(10);
        this.expiryDate = data.expiryDate || 0;
        this.strikePrice = data.strikePrice || 0;
        this.optionType = data.optionType || Buffer.alloc(2);
        this.caLevel = data.caLevel || 0;
    }
    static unpack(data) {
        let o = 0;
        const instrumentName = Buffer.from(data.slice(o, o + 6)); o += 6;
        const symbol = Buffer.from(data.slice(o, o + 10)); o += 10;
        const expiryDate = data.readUInt32BE(o); o += 4;
        const strikePrice = data.readUInt32BE(o); o += 4;
        const optionType = Buffer.from(data.slice(o, o + 2)); o += 2;
        const caLevel = data.readUInt16BE(o);
        return new ContractInfo({ instrumentName, symbol, expiryDate, strikePrice, optionType, caLevel });
    }
}

class OrderFlags {
    constructor(data) {
        data = data || {};
        this.aon = data.aon || 0; this.ioc = data.ioc || 0; this.gtc = data.gtc || 0;
        this.day = data.day || 0; this.mit = data.mit || 0; this.sl = data.sl || 0;
        this.market = data.market || 0; this.ato = data.ato || 0; this.reserved = data.reserved || 0;
        this.preOpen = data.preOpen || 0; this.frozen = data.frozen || 0; this.modified = data.modified || 0;
        this.traded = data.traded || 0; this.matchedInd = data.matchedInd || 0; this.mfb = data.mfb || 0;
    }
    static unpack(data) {
        const f = data.readUInt16BE(0);
        return new OrderFlags({
            aon: (f >> 0) & 1, ioc: (f >> 1) & 1, gtc: (f >> 2) & 1, day: (f >> 3) & 1,
            mit: (f >> 4) & 1, sl: (f >> 5) & 1, market: (f >> 6) & 1, ato: (f >> 7) & 1,
            reserved: (f >> 8) & 1, preOpen: (f >> 9) & 1, frozen: (f >> 10) & 1,
            modified: (f >> 11) & 1, traded: (f >> 12) & 1, matchedInd: (f >> 13) & 1, mfb: (f >> 14) & 1
        });
    }
    getFlagsString() {
        const f = [];
        if (this.gtc) f.push('GTC'); if (this.day) f.push('DAY'); if (this.ioc) f.push('IOC');
        if (this.aon) f.push('AON'); if (this.market) f.push('MARKET'); if (this.sl) f.push('SL');
        if (this.mit) f.push('MIT'); if (this.ato) f.push('ATO'); if (this.traded) f.push('TRADED');
        if (this.modified) f.push('MODIFIED');
        return f.length ? f.join('|') : 'NORMAL';
    }
}

class AdditionalOrderFlags {
    constructor(data) { data = data || {}; this.col = data.col || 0; this.reserved = data.reserved || 0; }
    static unpack(data) {
        const f = data.readUInt8(0);
        return new AdditionalOrderFlags({ col: (f >> 0) & 1, reserved: (f >> 1) & 1 });
    }
}

class TradeConfirmation {
    constructor(data) {
        data = data || {};
        this.header = data.header || new MessageHeader();
        this.responseOrderNumber = data.responseOrderNumber !== undefined ? String(data.responseOrderNumber) : '0';
        this.brokerId = data.brokerId || Buffer.alloc(5);
        this.reserved = data.reserved || Buffer.alloc(1);
        this.traderNum = data.traderNum || 0;
        this.accountNum = data.accountNum || Buffer.alloc(10);
        this.buySell = data.buySell || 0;
        this.originalVol = data.originalVol || 0;
        this.disclosedVol = data.disclosedVol || 0;
        this.remainingVol = data.remainingVol || 0;
        this.disclosedVolRemaining = data.disclosedVolRemaining || 0;
        this.price = data.price || 0;
        this.orderFlags = data.orderFlags || new OrderFlags();
        this.gtd = data.gtd || 0;
        this.fillNumber = data.fillNumber || 0;
        this.fillQty = data.fillQty || 0;
        this.fillPrice = data.fillPrice || 0;
        this.volFilledToday = data.volFilledToday || 0;
        this.activityType = data.activityType || 0;
        this.activityTime = data.activityTime || 0;
        this.opOrderNumber = data.opOrderNumber !== undefined ? String(data.opOrderNumber) : '0';
        this.opBrokerId = data.opBrokerId || Buffer.alloc(5);
        this.token = data.token || 0;
        this.contractDesc = data.contractDesc || new ContractInfo();
        this.openClose = data.openClose || 0;
        this.oldOpenClose = data.oldOpenClose || 0;
        this.bookType = data.bookType || 0;
        this.newVolume = data.newVolume || 0;
        this.oldAccountNumber = data.oldAccountNumber || Buffer.alloc(10);
        this.participant = data.participant || Buffer.alloc(12);
        this.oldParticipant = data.oldParticipant || Buffer.alloc(12);
        this.additionalOrderFlags = data.additionalOrderFlags || new AdditionalOrderFlags();
        this.reservedFiller = data.reservedFiller || 0;
        this.giveupTrade = data.giveupTrade || 0;
        this.reservedFiller2 = data.reservedFiller2 || 0;
        this.pan = data.pan || Buffer.alloc(10);
        this.oldPan = data.oldPan || Buffer.alloc(10);
        this.algoId = data.algoId || 0;
        this.algoCategory = data.algoCategory || 0;
        this.lastActivityReference = data.lastActivityReference !== undefined
            ? String(data.lastActivityReference) : '0';
        this.nnfField = data.nnfField || 0;
        this.reservedField = data.reservedField || Buffer.alloc(44);
        this.eventType = data.eventType || 'TRADE';
        this.processedTime = new Date().toISOString().replace('T', ' ').substring(0, 23);
    }
    static unpack(data) {
        let o = 0;
        const header = MessageHeader.unpack(data.slice(o, o + 40)); o += 40;

        // ---- ResponseOrderNumber (offset 40) ----
        // Spec type: DOUBLE (8 bytes). NSE packs the order number as a
        // floating-point number. readBigUInt64BE gives the raw bit pattern
        // (e.g. 4837762400322453926), NOT the actual order number.
        // readDoubleBE + Math.round gives the correct integer
        // (e.g. 2700000076955859).
        const responseOrderNumber = readPackedDoubleAsString(data, o); o += 8;

        const brokerId = Buffer.from(data.slice(o, o + 5)); o += 5;
        const reserved = Buffer.from(data.slice(o, o + 1)); o += 1;
        const traderNum = data.readUInt32BE(o); o += 4;
        const accountNum = Buffer.from(data.slice(o, o + 10)); o += 10;
        const buySell = data.readUInt16BE(o); o += 2;
        const originalVol = data.readUInt32BE(o); o += 4;
        const disclosedVol = data.readUInt32BE(o); o += 4;
        const remainingVol = data.readUInt32BE(o); o += 4;
        const disclosedVolRemaining = data.readUInt32BE(o); o += 4;
        const price = data.readUInt32BE(o); o += 4;
        const orderFlags = OrderFlags.unpack(data.slice(o, o + 2)); o += 2;
        const gtd = data.readUInt32BE(o); o += 4;
        const fillNumber = data.readUInt32BE(o); o += 4;
        const fillQty = data.readUInt32BE(o); o += 4;
        const fillPrice = data.readUInt32BE(o); o += 4;
        const volFilledToday = data.readUInt32BE(o); o += 4;
        const activityType = data.readUInt16BE(o); o += 2;
        const activityTime = data.readUInt32BE(o); o += 4;

        // ---- OpOrderNumber (offset 118) ----
        // Spec type: DOUBLE (8 bytes). Same handling as ResponseOrderNumber.
        const opOrderNumber = readPackedDoubleAsString(data, o); o += 8;

        const opBrokerId = Buffer.from(data.slice(o, o + 5)); o += 5;
        o += 1; // padding for LONG alignment
        const token = data.readUInt32BE(o); o += 4;
        const contractDesc = ContractInfo.unpack(data.slice(o, o + 28)); o += 28;
        const openClose = data.readUInt8(o); o += 1;
        const oldOpenClose = data.readUInt8(o); o += 1;
        const bookType = data.readUInt8(o); o += 1;
        o += 1; // padding for LONG alignment
        const newVolume = data.readUInt32BE(o); o += 4;
        const oldAccountNumber = Buffer.from(data.slice(o, o + 10)); o += 10;
        const participant = Buffer.from(data.slice(o, o + 12)); o += 12;
        const oldParticipant = Buffer.from(data.slice(o, o + 12)); o += 12;
        const additionalOrderFlags = AdditionalOrderFlags.unpack(data.slice(o, o + 1)); o += 1;
        const reservedFiller = data.readUInt8(o); o += 1;
        const giveupTrade = data.readUInt8(o); o += 1;
        const reservedFiller2 = data.readUInt8(o); o += 1;
        const pan = Buffer.from(data.slice(o, o + 10)); o += 10;
        const oldPan = Buffer.from(data.slice(o, o + 10)); o += 10;
        const algoId = data.readUInt32BE(o); o += 4;
        const algoCategory = data.readUInt16BE(o); o += 2;

        // ---- LastActivityReference ----
        // Spec type: LONG LONG (8 bytes) — genuine 64-bit integer, not a double.
        const lastActivityReference = data.readBigUInt64BE(o).toString(); o += 8;

        const nnfField = data.readDoubleBE(o); o += 8;
        const reservedField = Buffer.from(data.slice(o, o + 44));

        return new TradeConfirmation({
            header, responseOrderNumber, brokerId, reserved, traderNum, accountNum,
            buySell, originalVol, disclosedVol, remainingVol, disclosedVolRemaining,
            price, orderFlags, gtd, fillNumber, fillQty, fillPrice, volFilledToday,
            activityType, activityTime, opOrderNumber, opBrokerId, token, contractDesc,
            openClose, oldOpenClose, bookType, newVolume, oldAccountNumber, participant,
            oldParticipant, additionalOrderFlags, reservedFiller, giveupTrade,
            reservedFiller2, pan, oldPan, algoId, algoCategory, lastActivityReference,
            nnfField, reservedField
        });
    }
}

class SignonRequest {
    constructor(data) {
        data = data || {};
        this.header = data.header || new MessageHeader();
        this.userid = data.userid || 0;
        this.reserved1 = data.reserved1 || Buffer.alloc(8);
        this.password = data.password || Buffer.alloc(12);
        this.reserved2 = data.reserved2 || Buffer.alloc(4);
        this.reserved3 = data.reserved3 || Buffer.alloc(38);
        this.brokerId = data.brokerId || Buffer.alloc(5);
        this.reserved4 = data.reserved4 || Buffer.alloc(119);
        this.reserved5 = data.reserved5 || Buffer.alloc(16);
        this.reserved6 = data.reserved6 || Buffer.alloc(16);
        this.reserved7 = data.reserved7 || Buffer.alloc(16);
    }
    pack() {
        const u = Buffer.alloc(4);
        u.writeUInt32BE(this.userid, 0);
        return Buffer.concat([this.header.pack(), u, this.reserved1, this.password,
            this.reserved2, this.reserved3, this.brokerId, this.reserved4,
            this.reserved5, this.reserved6, this.reserved7]);
    }
    static unpack(data) {
        let o = 0;
        const header = MessageHeader.unpack(data.slice(o, o + 40)); o += 40;
        const userid = data.readUInt32BE(o); o += 4;
        const reserved1 = Buffer.from(data.slice(o, o + 8)); o += 8;
        const password = Buffer.from(data.slice(o, o + 12)); o += 12;
        const reserved2 = Buffer.from(data.slice(o, o + 4)); o += 4;
        const reserved3 = Buffer.from(data.slice(o, o + 38)); o += 38;
        const brokerId = Buffer.from(data.slice(o, o + 5)); o += 5;
        const reserved4 = Buffer.from(data.slice(o, o + 119)); o += 119;
        const reserved5 = Buffer.from(data.slice(o, o + 16)); o += 16;
        const reserved6 = Buffer.from(data.slice(o, o + 16)); o += 16;
        const reserved7 = Buffer.from(data.slice(o, o + 16));
        return new SignonRequest({ header, userid, reserved1, password, reserved2, reserved3, brokerId, reserved4, reserved5, reserved6, reserved7 });
    }
}

class DropCopyDownloadRequest {
    constructor(data) {
        data = data || {};
        this.header = data.header || new MessageHeader();
        this.sequenceNumber = data.sequenceNumber || 0;
    }
    pack() {
        const seqBuf = Buffer.alloc(8);
        seqBuf.writeDoubleBE(this.sequenceNumber, 0);
        return Buffer.concat([this.header.pack(), seqBuf]);
    }
}

class ErrorResponse {
    constructor(data) {
        data = data || {};
        this.header = data.header || new MessageHeader();
        this.reserved = data.reserved || Buffer.alloc(14);
        this.errorMessage = data.errorMessage || Buffer.alloc(128);
    }
    static unpack(data) {
        let o = 0;
        const header = MessageHeader.unpack(data.slice(o, o + 40)); o += 40;
        const reserved = Buffer.from(data.slice(o, o + 14)); o += 14;
        const errorMessage = Buffer.from(data.slice(o, o + 128));
        return new ErrorResponse({ header, reserved, errorMessage });
    }
}

class Packet {
    constructor(sequenceNumber, messageData) {
        sequenceNumber = sequenceNumber || 0;
        messageData = messageData || Buffer.alloc(0);
        this.length = 2 + 4 + 16 + messageData.length;
        this.sequenceNumber = sequenceNumber;
        this.checksum = Buffer.alloc(16);
        this.messageData = messageData;
    }
    calculateChecksum() { return crypto.createHash('md5').update(this.messageData).digest(); }
    pack() {
        this.checksum = this.calculateChecksum();
        const lenBuf = Buffer.alloc(2);
        lenBuf.writeUInt16BE(this.length, 0);
        const seqBuf = Buffer.alloc(4);
        seqBuf.writeUInt32BE(this.sequenceNumber, 0);
        return Buffer.concat([lenBuf, seqBuf, this.checksum, this.messageData]);
    }
    static unpack(data) {
        if (data.length < 22) throw new Error('Packet too short');
        const length = data.readUInt16BE(0);
        const sequenceNumber = data.readUInt32BE(2);
        const checksum = Buffer.from(data.slice(6, 22));
        const messageData = Buffer.from(data.slice(22, length));
        const p = new Packet(sequenceNumber, messageData);
        p.length = length;
        p.checksum = checksum;
        return p;
    }
    validate() {
        if (this.length > 1024) return false;
        if (this.length !== 2 + 4 + 16 + this.messageData.length) return false;
        return this.calculateChecksum().equals(this.checksum);
    }
}

// ============================================================================
// CSV Output Handler
// ============================================================================

class CSVOutputHandler {
    constructor(options) {
        options = options || {};
        this.outputDir = options.outputDir || 'output';
        this.filename = options.filename || 'trades.csv';
        this.delimiter = options.delimiter || ',';
        this.encoding = options.encoding || 'utf-8';
        this.mode = (options.mode || 'append').toLowerCase();
        if (!fs.existsSync(this.outputDir)) fs.mkdirSync(this.outputDir, { recursive: true });

        this.tradeColumns = [
            'member_id', 'trader_id', 'instrument', 'token', 'symbol',
            'expiry_date', 'strike_price', 'option_type', 'buy_sell',
            'ex_qty', 'ex_price', 'clnt_id', 'order_no', 'trade_no',
            'pan', 'nnf', 'timestamp', 'time', 'trade_status', 'algo_id'
        ];

        this.tradeCount = 0;
        this.isOpen = false;
        this.filePath = null;
    }
    open() {
        if (this.isOpen) return;
        this.filePath = path.join(this.outputDir, this.filename);
        const header = this.tradeColumns.join(this.delimiter) + '\n';

        if (this.mode === 'overwrite') {
            fs.writeFileSync(this.filePath, header, this.encoding);
            this.isOpen = true;
            this.tradeCount = 0;
            console.log('📄 CSV created (overwrite mode): ' + this.filePath);
            return;
        }

        if (fs.existsSync(this.filePath)) {
            const stats = fs.statSync(this.filePath);
            if (stats.size > 0) {
                try {
                    const content = fs.readFileSync(this.filePath, 'utf-8');
                    const lines = content.split('\n').filter(l => l.trim().length > 0);
                    this.tradeCount = Math.max(0, lines.length - 1);
                } catch (e) { this.tradeCount = 0; }
                this.isOpen = true;
                console.log('📄 CSV opened in APPEND mode — existing rows: ' + this.tradeCount);
                return;
            }
        }
        fs.writeFileSync(this.filePath, header, this.encoding);
        this.isOpen = true;
        this.tradeCount = 0;
        console.log('📄 CSV created: ' + this.filePath);
    }
    _esc(v) {
        const s = String(v);
        if (s.includes(this.delimiter) || s.includes('"') || s.includes('\n'))
            return '"' + s.replace(/"/g, '""') + '"';
        return s;
    }
    writeRow(row) {
        try {
            if (!this.isOpen) this.open();
            const self = this;
            const line = this.tradeColumns.map(c => self._esc(row[c] === undefined || row[c] === null ? '' : row[c])).join(this.delimiter) + '\n';
            fs.appendFileSync(this.filePath, line, this.encoding);
            this.tradeCount++;
            return true;
        } catch (e) { console.error('CSV write failed: ' + e.message); return false; }
    }
    close() { this.isOpen = false; }
    getStats() { return { total_trades: this.tradeCount, filename: this.filename, output_directory: this.outputDir, csv_filepath: this.filePath }; }
}

// ============================================================================
// Config Loader
// ============================================================================

class ConfigLoader {
    constructor(configFile) { this.configFile = configFile || 'config.ini'; }
    load() {
        if (!fs.existsSync(this.configFile)) this.createDefaultConfig();
        return this.parseConfig(ini.parse(fs.readFileSync(this.configFile, 'utf-8')));
    }
    createDefaultConfig() {
        const cfg = {
            connection: { host: '172.19.13.63', port: '10850', timeout: '30', reconnect_attempts: '5', reconnect_delay: '5', idle_timeout: '600' },
            company: { name: 'ABC Securities Pvt Ltd' },
            credentials: { user_id: '48857', password: 'YourPassword123', broker_id: '90254' },
            protocol: { endian: 'big', heartbeat_interval: '30', max_packet_size: '1024' },
            download: {
                start_sequence: '0',
                sequence_origin: 'zero',
                on_reconnect_sequence: 'latest',
                auto_full_day: 'true',
                signon_timeout_ms: '15000',
                stream_spacing_ms: '200'
            },
            logging: { log_level: 'INFO', log_file: 'logs/dropcopy.log', log_format: '%(asctime)s - %(levelname)s - %(message)s', log_max_bytes: '10485760', log_backup_count: '5' },
            csv_output: { output_dir: 'output', filename: 'trades.csv', delimiter: ',', encoding: 'utf-8', mode: 'overwrite' }
        };
        fs.writeFileSync(this.configFile, ini.stringify(cfg), 'utf-8');
        console.log('Created default configuration file: ' + this.configFile);
    }
    parseConfig(config) {
        const c = config.connection || {}, cr = config.credentials || {}, p = config.protocol || {};
        const l = config.logging || {}, csv = config.csv_output || {}, dl = config.download || {};
        const co = config.company || {};
        return {
            connection: {
                host: c.host || '172.19.13.63', port: parseInt(c.port) || 10850,
                timeout: parseInt(c.timeout) || 30, reconnect_attempts: parseInt(c.reconnect_attempts) || 5,
                reconnect_delay: parseInt(c.reconnect_delay) || 5, idle_timeout: parseInt(c.idle_timeout) || 600
            },
            company: {
                name: (co.name && String(co.name).trim()) ? String(co.name).trim() : 'ABC Securities Pvt Ltd'
            },
            credentials: { user_id: parseInt(cr.user_id) || 0, password: cr.password || '', broker_id: cr.broker_id || '' },
            protocol: { endian: p.endian || 'big', heartbeat_interval: parseInt(p.heartbeat_interval) || 30, max_packet_size: parseInt(p.max_packet_size) || 1024 },
            download: {
                start_sequence: parseInt(dl.start_sequence) || 0,
                sequence_origin: (dl.sequence_origin || 'zero').toLowerCase(),
                on_reconnect_sequence: (dl.on_reconnect_sequence || 'latest').toLowerCase(),
                auto_full_day: String(dl.auto_full_day || 'true').toLowerCase() === 'true',
                signon_timeout_ms: parseInt(dl.signon_timeout_ms) || 15000,
                stream_spacing_ms: parseInt(dl.stream_spacing_ms) || 200
            },
            logging: {
                log_level: l.log_level || 'INFO', log_file: l.log_file || 'dropcopy.log',
                log_format: l.log_format || '%(asctime)s - %(levelname)s - %(message)s',
                log_max_bytes: parseInt(l.log_max_bytes) || 10485760, log_backup_count: parseInt(l.log_backup_count) || 5
            },
            csv_output: {
                output_dir: csv.output_dir || 'output', filename: csv.filename || 'trades.csv',
                delimiter: csv.delimiter || ',', encoding: csv.encoding || 'utf-8',
                mode: (csv.mode || 'append').toLowerCase()
            }
        };
    }
}

// ============================================================================
// Drop Copy Client
// ============================================================================

class DropCopyClient extends EventEmitter {
    constructor(config) {
        super();
        this.config = config;
        const conn = config.connection, creds = config.credentials, proto = config.protocol;

        this.host = conn.host;
        this.port = conn.port;
        this.userId = creds.user_id;
        this.password = creds.password;
        this.brokerId = creds.broker_id;
        this.heartbeatInterval = proto.heartbeat_interval;
        this.idleTimeout = conn.idle_timeout || 600;
        this.connectionTimeout = conn.timeout;
        this.reconnectAttempts = conn.reconnect_attempts;
        this.reconnectDelay = conn.reconnect_delay;

        this.socket = null;
        this.sequenceNumber = 0;
        this.streams = [];
        this.lastReceivedTime = 0;
        this.lastHeartbeatTime = 0;
        this.connected = false;
        this.loggedIn = false;
        this.running = false;
        this._recvBuffer = Buffer.alloc(0);
        this._pendingResolve = null;

        const dl = config.download || {};
        this.downloadConfig = {
            start_sequence: typeof dl.start_sequence === 'number' ? dl.start_sequence : 0,
            sequence_origin: dl.sequence_origin || 'zero',
            on_reconnect_sequence: dl.on_reconnect_sequence || 'latest',
            auto_full_day: dl.auto_full_day !== false,
            signon_timeout_ms: dl.signon_timeout_ms || 15000,
            stream_spacing_ms: dl.stream_spacing_ms || 200
        };

        this._lastMessageTs = '0';
        this._lastTradeDate = null;
        this._isFirstConnectionOfSession = true;

        const csvCfg = config.csv_output || {};
        this.csvHandler = new CSVOutputHandler({
            outputDir: csvCfg.output_dir || 'output', filename: csvCfg.filename || 'trades.csv',
            delimiter: csvCfg.delimiter || ',', encoding: csvCfg.encoding || 'utf-8',
            mode: csvCfg.mode || 'append'
        });
        this.csvHandler.open();

        const logCfg = config.logging || {};
        this.logger = new Logger(logCfg.log_file, logCfg.log_level, logCfg.log_max_bytes, logCfg.log_backup_count);

        this.stats = {
            trades_received: 0, trades_written: 0, heartbeats_sent: 0,
            data_received: 0, errors: 0, start_time: new Date(), reconnections: 0
        };

        // Throttle live stats emission (max once every 250ms)
        this._lastStatsEmit = 0;
        this._statsEmitIntervalMs = 250;
    }

    async connect() {
        const self = this;
        return new Promise(resolve => {
            try {
                self.socket = new net.Socket();
                self.socket.setTimeout(self.connectionTimeout * 1000);
                self.socket.setKeepAlive(true, 30000);
                self.socket.setNoDelay(true);

                self.socket.on('connect', () => {
                    self.connected = true;
                    self.sequenceNumber = 0;
                    self.lastReceivedTime = Date.now() / 1000;
                    self.lastHeartbeatTime = Date.now() / 1000;
                    self._recvBuffer = Buffer.alloc(0);
                    self.logger.info('✅ Connected to ' + self.host + ':' + self.port);
                    self.emit('status', { connected: true, host: self.host, port: self.port });
                    resolve(true);
                });

                self.socket.on('data', (data) => {
                    self._recvBuffer = Buffer.concat([self._recvBuffer, data]);
                    self._tryProcessPacket();
                });

                self.socket.on('error', (err) => {
                    self.logger.error('❌ Socket error: ' + err.message);
                    self.connected = false;
                    self.emit('status', { connected: false, error: err.message });
                    if (self._pendingResolve) {
                        const fn = self._pendingResolve;
                        self._pendingResolve = null;
                        try { fn(null); } catch (e) {}
                    }
                    resolve(false);
                });

                self.socket.on('close', () => {
                    self.logger.warning('Socket closed');
                    self.connected = false;
                    if (self._pendingResolve) {
                        const fn = self._pendingResolve;
                        self._pendingResolve = null;
                        try { fn(null); } catch (e) {}
                    }
                });
                self.socket.on('timeout', () => self.logger.warning('Socket timeout'));

                self.socket.connect(self.port, self.host);
            } catch (e) {
                self.logger.error('❌ Connect failed: ' + e.message);
                resolve(false);
            }
        });
    }

    disconnect(userInitiated) {
        if (userInitiated === undefined || userInitiated === true) this.running = false;
        this._isFirstConnectionOfSession = true;
        if (this.socket) { try { this.socket.destroy(); } catch (e) {} }
        this.connected = false;
        this.loggedIn = false;
        this.socket = null;
        if (this._pendingResolve) {
            const fn = this._pendingResolve;
            this._pendingResolve = null;
            try { fn(null); } catch (e) {}
        }
        this.emit('status', { connected: false });
        this.logger.info('🔌 Disconnected' + (this.running ? ' (preparing to reconnect)' : ''));
    }

    async login() {
        if (!this._sendSignonRequest()) return false;
        const response = await this._receivePacket(this.downloadConfig.signon_timeout_ms);
        if (!response) {
            this.logger.warning('🔐 No sign-on response within ' +
                Math.round(this.downloadConfig.signon_timeout_ms / 1000) + 's');
            return false;
        }
        if (!this._handleSignonResponse(response)) return false;
        this.loggedIn = true;
        this.logger.info('✅ Login successful. Streams: ' + JSON.stringify(this.streams));
        this.emit('login', { success: true, streams: this.streams, userId: this.userId });
        return true;
    }

    _sendSignonRequest() {
        try {
            const header = new MessageHeader({
                transactionCode: TransactionCode.SIGN_ON_REQUEST_IN,
                logTime: 0, alphaChar: Buffer.from('  '), userId: this.userId,
                errorCode: 0, timestamp: '0',
                timestamp1: Buffer.alloc(8), timestamp2: Buffer.alloc(8),
                messageLength: 278
            });
            const pwBytes = Buffer.from(String(this.password), 'ascii').slice(0, 12);
            const pwPad = Buffer.alloc(12); pwBytes.copy(pwPad);
            const bBytes = Buffer.from(String(this.brokerId), 'ascii').slice(0, 5);
            const bPad = Buffer.alloc(5); bBytes.copy(bPad);
            const signon = new SignonRequest({
                header, userid: this.userId, reserved1: Buffer.alloc(8),
                password: pwPad, reserved2: Buffer.alloc(4), reserved3: Buffer.alloc(38),
                brokerId: bPad, reserved4: Buffer.alloc(119),
                reserved5: Buffer.alloc(16), reserved6: Buffer.alloc(16), reserved7: Buffer.alloc(16)
            });
            this.logger.info('🔐 Sending SIGN_ON...');
            return this._sendMessage(signon.pack());
        } catch (e) {
            this.logger.error('Sign-on request failed: ' + e.message);
            return false;
        }
    }

    _handleSignonResponse(data) {
        try {
            try {
                const error = ErrorResponse.unpack(data);
                if (error.header.errorCode !== 0) {
                    const msg = error.errorMessage.toString('ascii').trim();
                    this.logger.error('❌ Sign-on error: ' + msg + ' (code=' + error.header.errorCode + ')');
                    return false;
                }
            } catch (e) {}

            const signon = SignonRequest.unpack(data);
            if (signon.header.alphaChar) {
                const numStreams = signon.header.alphaChar[0];
                this.streams = [];
                for (let i = 1; i <= numStreams; i++) this.streams.push(i);
                this.logger.info('📡 Streams available: ' + numStreams);
                return true;
            }
            this.logger.warning('Sign-on response missing alpha_char');
            return false;
        } catch (e) {
            this.logger.error('Sign-on response parse error: ' + e.message);
            return false;
        }
    }

    _computeStartSequence() {
        const cfg = this.downloadConfig;

        if (cfg.sequence_origin === 'live') {
            const ts = nowNseSeconds();
            this.logger.info('[download] LIVE mode → seq=' + ts + ' (only new trades)');
            return ts;
        }

        const now = new Date();
        const ist = new Date(now.getTime() + IST_OFFSET_MS + (now.getTimezoneOffset() * 60000));
        const today = ist.toISOString().slice(0, 10);
        const isNewDay = cfg.auto_full_day && this._lastTradeDate && this._lastTradeDate !== today;

        if (this._isFirstConnectionOfSession) {
            this._isFirstConnectionOfSession = false;
            if (cfg.sequence_origin === 'auto') {
                const ts = dateToNseSeconds(todayMarketOpenIST());
                this.logger.info('[download] First connect — auto → ' + ts);
                return ts;
            }
            if (cfg.sequence_origin === 'literal') {
                this.logger.info('[download] First connect — literal → ' + cfg.start_sequence);
                return cfg.start_sequence;
            }
            this.logger.info('[download] First connect — zero → 0 (full day replay)');
            return 0;
        }

        if (isNewDay) {
            this.logger.info('[download] New trading day — reset');
            this._lastTradeDate = null;
            this._lastMessageTs = '0';
            return cfg.sequence_origin === 'literal' ? cfg.start_sequence : 0;
        }

        switch (cfg.on_reconnect_sequence) {
            case 'zero':
                return 0;
            case 'latest':
                this.logger.info('[download] Reconnect — latest → ' + nowNseSeconds());
                return nowNseSeconds();
            case 'resume':
            default:
                if (this._lastMessageTs && this._lastMessageTs !== '0') {
                    this.logger.info('[download] Reconnect — resume from ' + this._lastMessageTs);
                    try {
                        return Number(BigInt(this._lastMessageTs) / 1000000000n) + 1;
                    } catch (e) { return 0; }
                }
                return 0;
        }
    }

    async _sendAllDownloadRequestsOnce() {
        const seq = this._computeStartSequence();
        const spacing = this.downloadConfig.stream_spacing_ms;
        this.logger.info('📤 Sending ' + this.streams.length + ' download requests (spacing ' +
            spacing + 'ms, seq=' + seq + ')...');

        for (let i = 0; i < this.streams.length; i++) {
            const sn = this.streams[i];
            this._sendDownloadRequest(sn, seq);
            if (i < this.streams.length - 1) await sleep(spacing);
        }
        this.logger.info('✅ All ' + this.streams.length + ' download requests sent — streaming live');
    }

    _sendDownloadRequest(streamNum, seq) {
        try {
            const header = new MessageHeader({
                transactionCode: TransactionCode.DC_DOWNLOAD_REQUEST,
                logTime: 0, alphaChar: Buffer.from([streamNum, 0]), userId: this.userId,
                errorCode: 0, timestamp: '0',
                timestamp1: Buffer.alloc(8), timestamp2: Buffer.alloc(8),
                messageLength: 48
            });
            const req = new DropCopyDownloadRequest({ header, sequenceNumber: seq });
            this.logger.info('[download] stream=' + streamNum + ' seq=' + seq);
            return this._sendMessage(req.pack());
        } catch (e) {
            this.logger.error('Download send failed: ' + e.message);
            return false;
        }
    }

    _sendHeartbeat() {
        try {
            if (!this.connected || !this.socket) return false;
            const header = new MessageHeader({
                transactionCode: TransactionCode.HEARTBEAT,
                logTime: 0, alphaChar: Buffer.from('  '), userId: this.userId,
                errorCode: 0, timestamp: '0',
                timestamp1: Buffer.alloc(8), timestamp2: Buffer.alloc(8),
                messageLength: 40
            });
            const ok = this._sendMessage(header.pack());
            if (ok) {
                this.stats.heartbeats_sent++;
                this.logger.info('💓 HEARTBEAT SENT');
                this.emit('heartbeat', { direction: 'sent', time: new Date().toISOString() });
            }
            return ok;
        } catch (e) {
            this.logger.error('Heartbeat failed: ' + e.message);
            return false;
        }
    }

    _packMessage(messageData) {
        this.sequenceNumber++;
        return new Packet(this.sequenceNumber, messageData).pack();
    }

    _sendMessage(messageData) {
        try {
            if (!this.socket) return false;
            if (this.socket.destroyed || !this.socket.writable) {
                this.logger.warning('Send skipped: socket not writable');
                return false;
            }
            this.socket.write(this._packMessage(messageData));
            return true;
        } catch (e) {
            this.logger.error('Send error: ' + e.message);
            this.connected = false;
            return false;
        }
    }

    _receivePacket(timeout) {
        timeout = timeout || 10000;
        const self = this;
        return new Promise(resolve => {
            if (!self.socket || self.socket.destroyed) { resolve(null); return; }
            let resolved = false;
            let timer = null;
            const done = (data) => {
                if (resolved) return;
                resolved = true;
                if (timer) clearTimeout(timer);
                if (self.socket) {
                    try { self.socket.removeListener('close', onClose); } catch (e) {}
                    try { self.socket.removeListener('error', onError); } catch (e) {}
                }
                self._pendingResolve = null;
                resolve(data);
            };
            const onClose = () => done(null);
            const onError = () => done(null);
            timer = setTimeout(() => done(null), timeout);
            self.socket.once('close', onClose);
            self.socket.once('error', onError);
            self._pendingResolve = data => done(data);
        });
    }

    _tryProcessPacket() {
        while (this._recvBuffer.length >= 2) {
            const length = this._recvBuffer.readUInt16BE(0);
            if (length < 22 || length > 1024) {
                this.logger.warning('Invalid packet length ' + length + ' — dropping buffer');
                this._recvBuffer = Buffer.alloc(0);
                return;
            }
            if (this._recvBuffer.length < length) return;
            const packetData = this._recvBuffer.slice(0, length);
            this._recvBuffer = this._recvBuffer.slice(length);

            try {
                const packet = Packet.unpack(packetData);
                if (!packet.validate()) { this.logger.warning('Packet validation failed'); continue; }
                this.lastReceivedTime = Date.now() / 1000;
                this.stats.data_received++;

                if (this._pendingResolve) this._pendingResolve(packet.messageData);
                else this._processMessage(packet.messageData);
            } catch (e) {
                this.logger.error('Packet processing error: ' + e.message);
            }
        }
    }

    _processMessage(messageData) {
        if (messageData.length < 40) return;
        try {
            const header = MessageHeader.unpack(messageData.slice(0, 40));
            const tc = header.transactionCode;

            if (tc === TransactionCode.TRADE_CONFIRMATION) {
                this._handleTrade(TradeConfirmation.unpack(messageData));
            } else if (tc === TransactionCode.TRADE_MODIFY_CONFIRM) {
                const t = TradeConfirmation.unpack(messageData); t.eventType = 'MODIFY_CONFIRM'; this._handleTrade(t);
            } else if (tc === TransactionCode.TRADE_MODIFY_REJECT) {
                const t = TradeConfirmation.unpack(messageData); t.eventType = 'MODIFY_REJECT'; this._handleTrade(t);
            } else if (tc === TransactionCode.TRADE_CANCEL_CONFIRM) {
                const t = TradeConfirmation.unpack(messageData); t.eventType = 'CANCEL_CONFIRM'; this._handleTrade(t);
            } else if (tc === TransactionCode.TRADE_CANCEL_REJECT) {
                const t = TradeConfirmation.unpack(messageData); t.eventType = 'CANCEL_REJECT'; this._handleTrade(t);
            } else if (tc === TransactionCode.HEARTBEAT) {
                this.logger.info('💓 HEARTBEAT RECEIVED');
                this.emit('heartbeat', { direction: 'received', time: new Date().toISOString() });
            }
        } catch (e) {
            this.logger.error('Message processing error: ' + e.message);
        }
    }

    _handleTrade(trade) {
        this.stats.trades_received++;

        try {
            const ts = trade.header ? trade.header.timestamp : '0';
            if (ts && ts !== '0') {
                try {
                    if (BigInt(ts) > BigInt(this._lastMessageTs)) this._lastMessageTs = ts;
                } catch (e) {}
            }
            try {
                const msNum = NSE_EPOCH_MS + Number(BigInt(ts) / 1000000n);
                const d = new Date(msNum);
                if (!isNaN(d.getTime())) this._lastTradeDate = d.toISOString().slice(0, 10);
            } catch (e) {}
        } catch (e) {}

        const row = tradeToRow(trade);

        this.logger.info('📊 ' + row.trade_status + ' | ' + row.instrument + ' ' + row.symbol +
            ' ' + row.option_type + ' | ' + row.buy_sell + ' | Qty:' + row.ex_qty +
            ' @ ₹' + row.ex_price + ' | Exp:' + row.expiry_date +
            ' | Time:' + row.time + ' | OrderNo:' + row.order_no + ' | TradeNo:' + row.trade_no);

        try {
            this.csvHandler.writeRow(row);
            this.stats.trades_written++;
        } catch (e) {
            this.logger.error('CSV write failed: ' + e.message);
        }

        this.emit('trade', row);

        // Live stats emission — throttled to 250ms to avoid IPC flood
        const now = Date.now();
        if (now - this._lastStatsEmit >= this._statsEmitIntervalMs) {
            this._lastStatsEmit = now;
            this.emit('stats', this.getStats());
        }
    }

    getStats() {
        const runtime = Math.floor((Date.now() - this.stats.start_time.getTime()) / 1000);
        const csvStats = this.csvHandler.getStats();
        return {
            runtime,
            tradesReceived: this.stats.trades_received,
            tradesWritten: this.stats.trades_written,
            heartbeatsSent: this.stats.heartbeats_sent,
            dataReceived: this.stats.data_received,
            reconnections: this.stats.reconnections,
            connected: this.connected, loggedIn: this.loggedIn, running: this.running,
            csvPath: csvStats.csv_filepath, csvTrades: csvStats.total_trades,
            lastMessageTs: this._lastMessageTs,
            streamCount: this.streams.length
        };
    }

    _printHeader() {
        console.log('\n' + '='.repeat(75));
        console.log('NSE DROP COPY CLIENT');
        console.log('='.repeat(75));
        console.log('Host: ' + this.host + ':' + this.port);
        console.log('User ID: ' + this.userId);
        console.log('Broker ID: ' + this.brokerId);
        console.log('Mode: ' + this.downloadConfig.sequence_origin);
        console.log('CSV: ' + this.csvHandler.outputDir + '/' + this.csvHandler.filename + ' (' + this.csvHandler.mode + ')');
        console.log('='.repeat(75) + '\n');
    }

    _printStats() {
        const runtime = Math.floor((Date.now() - this.stats.start_time.getTime()) / 1000);
        const csvStats = this.csvHandler.getStats();
        console.log('\n' + '='.repeat(75));
        console.log('STATISTICS');
        console.log('='.repeat(75));
        console.log('Runtime: ' + Math.floor(runtime / 3600) + 'h ' + Math.floor((runtime % 3600) / 60) + 'm ' + (runtime % 60) + 's');
        console.log('Trades received this session: ' + this.stats.trades_received);
        console.log('Trades written this session: ' + this.stats.trades_written);
        console.log('Total trades in CSV: ' + csvStats.total_trades);
        console.log('CSV: ' + csvStats.csv_filepath);
        console.log('='.repeat(75) + '\n');
    }

    async run() {
        this.running = true;
        this._printHeader();

        while (this.running) {
            try {
                if (!(await this._connectWithRetry())) break;
                if (!(await this._loginWithRetry())) {
                    this.logger.warning('❌ All login attempts failed. Waiting before full reconnect...');
                    this.disconnect(false);
                    await sleep(this.reconnectDelay * 1000);
                    continue;
                }

                // Signal UI to clear its table BEFORE streaming new data.
                const reason = this._isFirstConnectionOfSession ? 'start' : 'reconnect';
                this.logger.info('🔄 Emitting reset (reason=' + reason + ') — UI will clear live trades');
                this.emit('reset', { reason: reason, time: new Date().toISOString() });

                await this._sendAllDownloadRequestsOnce();
                await this._mainLoop();

                if (this.running) {
                    this.logger.warning('⚠️ Connection lost, reconnecting...');
                    this.stats.reconnections++;
                    this.disconnect(false);
                    this._isFirstConnectionOfSession = false;
                    await sleep(2000);
                }
            } catch (e) {
                this.logger.error('Run error: ' + e.message);
                break;
            }
        }

        this._printStats();
        this.disconnect(true);
        this.csvHandler.close();
    }

    async _connectWithRetry() {
        for (let attempt = 1; attempt <= this.reconnectAttempts; attempt++) {
            this.logger.info('🔗 Connection ' + attempt + '/' + this.reconnectAttempts);
            if (await this.connect()) return true;
            if (attempt < this.reconnectAttempts) await sleep(this.reconnectDelay * 1000);
        }
        return false;
    }

    async _loginWithRetry() {
        for (let attempt = 1; attempt <= this.reconnectAttempts; attempt++) {
            this.logger.info('🔐 Login ' + attempt + '/' + this.reconnectAttempts);
            if (!this.socket || this.socket.destroyed || !this.connected) {
                this.logger.info('🔐 Socket dead — reconnecting before login...');
                if (this.socket) { try { this.socket.destroy(); } catch (e) {} }
                this.socket = null;
                this.connected = false;
                if (!(await this.connect())) {
                    if (attempt < this.reconnectAttempts) await sleep(this.reconnectDelay * 1000);
                    continue;
                }
            }
            if (await this.login()) return true;
            if (attempt < this.reconnectAttempts) await sleep(this.reconnectDelay * 1000);
        }
        return false;
    }

    async _mainLoop() {
        this.lastHeartbeatTime = Date.now() / 1000;
        this.logger.info('📡 Streaming — waiting for trade data...');

        while (this.running && this.connected && this.loggedIn) {
            try {
                await sleep(1000);
                const now = Date.now() / 1000;

                if (now - this.lastHeartbeatTime > this.heartbeatInterval) {
                    if (this._sendHeartbeat()) this.lastHeartbeatTime = now;
                    else { this.logger.warning('Heartbeat failed'); this.connected = false; break; }
                }

                if (now - this.lastReceivedTime > this.idleTimeout) {
                    this.logger.warning('⚠️ Idle for ' + Math.round(now - this.lastReceivedTime) + 's — reconnecting');
                    this.connected = false;
                    break;
                }
            } catch (e) {
                this.logger.error('Main loop error: ' + e.message);
                this.connected = false;
                break;
            }
        }

        const reasons = [];
        if (!this.running) reasons.push('running=false');
        if (!this.connected) reasons.push('connected=false');
        if (!this.loggedIn) reasons.push('loggedIn=false');
        this.logger.info('📡 Main loop exited: ' + (reasons.join(', ') || 'unknown'));
    }
}

module.exports = {
    DropCopyClient, ConfigLoader, CSVOutputHandler,
    MessageHeader, TradeConfirmation, TransactionCode, Packet
};
