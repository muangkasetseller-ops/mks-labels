/* Core logic: CSV -> labels. Works in browser (window.Core) and node (module.exports). */
(function (root) {
  'use strict';

  // ---------- CSV ----------
  function decodeBuffer(buf) {
    const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    if (u8[0] === 0xff && u8[1] === 0xfe) return new TextDecoder('utf-16le').decode(u8.subarray(2));
    if (u8[0] === 0xfe && u8[1] === 0xff) return new TextDecoder('utf-16be').decode(u8.subarray(2));
    if (u8[0] === 0xef && u8[1] === 0xbb && u8[2] === 0xbf) return new TextDecoder('utf-8').decode(u8.subarray(3));
    // no BOM: many NULs => utf-16le
    let nul = 0;
    for (let i = 1; i < Math.min(u8.length, 200); i += 2) if (u8[i] === 0) nul++;
    if (nul > 20) return new TextDecoder('utf-16le').decode(u8);
    return new TextDecoder('utf-8').decode(u8);
  }

  // quote-aware delimited parser
  function parseDelimited(text, delim) {
    const rows = [];
    let row = [], field = '', inQ = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (inQ) {
        if (c === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false;
        } else field += c;
      } else if (c === '"' && field === '') inQ = true;
      else if (c === delim) { row.push(field); field = ''; }
      else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else if (c === '\r') { /* skip */ }
      else field += c;
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    return rows;
  }

  function parseCsvText(text) {
    const first = text.split('\n', 1)[0];
    const delim = first.includes('\t') ? '\t' : ',';
    const rows = parseDelimited(text, delim).filter(r => r.some(x => x !== ''));
    const head = rows[0].map(h => h.trim());
    return rows.slice(1).map(r => {
      const o = {};
      head.forEach((h, i) => { if (!(h in o) || o[h] === '') o[h] = (r[i] || '').trim(); });
      return o;
    });
  }

  // ---------- cleaning ----------
  const stripQuote = s => (s || '').replace(/^'+/, '').trim();

  const NOISE = /(ปลายทาง|เก็บค่า|ค่าส่ง|ค่าขนส่ง|ชำระต้นทาง|ออเดอร์เซล|ไม่เอาชื่อผู้ส่ง|ใบเสร็จ|รับเอง|ให้โทร|โทรมาก่อน|โทรคุย|ปฎิทิน|ปฏิทิน|ใช้อะ)/;

  function cleanTransport(note, aliases) {
    let t = (note || '').replace(/[*#"]/g, ' ');
    const lines = t.split(/\n/).map(x => x.trim()).filter(Boolean);
    if (!lines.length) return '';
    t = lines[0];
    // cut at fee/instruction words, "/" fee style
    const m = t.match(NOISE);
    if (m) t = t.slice(0, m.index);
    t = t.replace(/\s*\/\s*\d.*$/, '').replace(/\s+/g, ' ').trim();
    if (!t) return '';
    // alias table: first match wins
    for (const [pat, canon] of aliases) {
      if (new RegExp(pat, 'i').test(t)) return canon;
    }
    // generic: "XXXขนส่ง" -> "ขนส่งXXX"
    if (!/^(ขนส่ง|บริษัท|หจก)/.test(t)) {
      t = /ขนส่ง$/.test(t) ? 'ขนส่ง' + t.replace(/\s*ขนส่ง$/, '').trim() : 'ขนส่ง' + t;
    }
    return t;
  }

  function cleanName(name) {
    return (name || '')
      .replace(/\(\s*ลูกค้าใน\s*ไลน์\s*\)/g, '')
      .replace(/^ร้านค้า\s+/, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function cleanAddress(addr, customerName) {
    let a = (addr || '').replace(/^"+|"+$/g, '').replace(/\s+/g, ' ').trim();
    if (customerName) {
      const n = customerName.replace(/\s+/g, ' ').trim();
      if (n && a.startsWith(n)) a = a.slice(n.length).trim();
    }
    a = a.replace(/^ที่อยู่\s*/, '');
    return a;
  }

  // ---------- products / pieces ----------
  const skuKey = s => { const m = (s || '').toUpperCase().match(/^[A-Z]+\d+/); return m ? m[0] : ''; };
  const normName = s => (s || '').replace(/\s+/g, ' ').trim();

  function lookupProduct(item, bySku, byName) {
    const k = skuKey(item.sku);
    if (k && bySku[k]) return bySku[k];
    const n = normName(item.name);
    if (n && byName[n]) return byName[n];
    return null;
  }

  // mode: 'perItem' = sum of ceil(qty/pack) for each item (default)
  //       'combined' = ceil(sum of qty/pack)
  function computePieces(items, bySku, byName, mode) {
    let total = 0, frac = 0;
    const detail = [], unknown = [];
    for (const it of items) {
      if (/^FOC/i.test(it.sku || '')) { detail.push({ ...it, skip: 'ของแถม' }); continue; }
      if (!it.qty) continue;
      const p = lookupProduct(it, bySku, byName);
      if (!p || !p.p) { unknown.push(it); detail.push({ ...it, unknown: true }); continue; }
      const boxes = it.qty / p.p;
      total += Math.ceil(boxes - 1e-9);
      frac += boxes;
      detail.push({ ...it, pack: p.p, boxes });
    }
    const pieces = mode === 'combined' ? Math.ceil(frac - 1e-9) : total;
    return { pieces, detail, unknown };
  }

  // ---------- orders ----------
  function buildOrders(rows, ctx) {
    const { aliases, bySku, byName, mode } = ctx;
    const map = new Map();
    for (const r of rows) {
      const no = r['No.'];
      if (!no) continue;
      if (!map.has(no)) map.set(no, { no, first: r, items: [] });
      map.get(no).items.push({
        sku: r['SKU'] || '',
        name: r['Item Name'] || '',
        qty: parseFloat(r['Item Qty'] || '0') || 0,
      });
    }
    const out = [];
    for (const o of map.values()) {
      const r = o.first;
      const note = r['Note'] || '';
      const name = cleanName(r['Customer Name']);
      const calc = computePieces(o.items, bySku, byName, mode);
      const warn = [];
      const transport = cleanTransport(note, aliases);
      const address = cleanAddress(r['Customer Address'], name);
      if (!transport) warn.push('ไม่มีชื่อขนส่งในโน้ต');
      if (!address) warn.push('ไม่มีที่อยู่');
      if (calc.unknown.length) warn.push('หาสินค้าในตารางไม่เจอ: ' + calc.unknown.map(u => u.sku || u.name).join(', '));
      out.push({
        no: o.no,
        transport,
        name,
        phone: stripQuote(r['Customer Phone']),
        address,
        pieces: calc.pieces,
        nosender: /ไม่เอาชื่อผู้ส่ง/.test(note),
        note: note.replace(/\s+/g, ' ').trim(),
        detail: calc.detail,
        warn,
        include: true,
      });
    }
    return out;
  }

  const api = { decodeBuffer, parseCsvText, parseDelimited, cleanTransport, cleanName, cleanAddress, skuKey, computePieces, buildOrders, stripQuote };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.Core = api;
})(typeof window !== 'undefined' ? window : globalThis);
