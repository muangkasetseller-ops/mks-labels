(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const C = window.Core;
  const HIST_KEY = 'mk_label_history_v1';
  let orders = [];
  let allRows = [];

  // ประวัติ "เคยทำแล้ว" รีเซ็ตทุกวัน (ตามวันที่ในเครื่อง) — เก็บเฉพาะของวันนี้
  const dayKey = t => { const d = new Date(t); return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate(); };
  function loadHist() {
    let h = {};
    try { h = JSON.parse(localStorage.getItem(HIST_KEY) || '{}'); } catch (e) { return {}; }
    const today = dayKey(Date.now());
    const out = {};
    for (const k in h) if (h[k] && h[k].t && dayKey(h[k].t) === today) out[k] = h[k];
    if (Object.keys(out).length !== Object.keys(h).length) saveHist(out);
    return out;
  }
  function saveHist(h) { try { localStorage.setItem(HIST_KEY, JSON.stringify(h)); } catch (e) { /* ignore */ } }

  // ---------- load ----------
  async function readFiles(files) {
    allRows = [];
    for (const f of files) {
      const buf = await f.arrayBuffer();
      const rows = C.parseCsvText(C.decodeBuffer(buf));
      allRows = allRows.concat(rows);
    }
    rebuild();
  }

  function rebuild() {
    const hist = loadHist();
    orders = C.buildOrders(allRows, {
      aliases: window.TRANSPORT_ALIASES,
      bySku: window.PRODUCTS_BY_SKU,
      byName: window.PRODUCTS_BY_NAME,
      mode: $('mode').value,
    });
    // dedupe by order number across files
    const seen = new Set();
    orders = orders.filter(o => !seen.has(o.no) && seen.add(o.no));
    for (const o of orders) {
      o.dest = o.transport; o.seq = '';
      o.done = !!hist[o.no];
      // ลูกค้าซ้ำ: เบอร์เดียวกับออเดอร์ที่ทำไปแล้ววันนี้ หรือออเดอร์อื่นในไฟล์ที่อัปโหลดอยู่
      o.repeat = o.phone ? Object.keys(hist).filter(k => k !== o.no && hist[k].phone === o.phone)
        .concat(orders.filter(x => x !== o && x.phone === o.phone).map(x => x.no)) : [];
      o.repeat = o.repeat.filter((v, i, a) => a.indexOf(v) === i);
    }
    render();
  }

  // ---------- table ----------
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  function render() {
    $('result').hidden = !orders.length;
    $('cfcard').hidden = !orders.length;
    const hide = $('hideDone').checked;
    const F = (cls, label, f, val, type) => '<label class="f ' + cls + '"><span>' + label + '</span><input type="' + (type || 'text') + '"' + (type === 'number' ? ' min="0"' : '') + ' data-f="' + f + '" value="' + esc(val) + '"></label>';
    const body = orders.map((o, i) => {
      if (hide && o.done) return '';
      const tags = [];
      if (o.done) tags.push('<span class="tag d">ทำไปแล้ววันนี้</span>');
      if (o.repeat.length) tags.push('<span class="tag w">ลูกค้าซ้ำ: ' + esc(o.repeat.slice(0, 4).join(', ')) + (o.repeat.length > 4 ? '…' : '') + '</span>');
      o.warn.forEach(w => tags.push('<span class="tag w">' + esc(w) + '</span>'));
      if (o.nosender) tags.push('<span class="tag w">ไม่ใส่ชื่อผู้ส่ง</span>');
      const det = o.detail.map(d => '<tr><td>' + esc(d.sku) + '</td><td>' + esc(d.name) + '</td><td>' + d.qty + '</td><td>' +
        (d.skip ? esc(d.skip) : d.unknown ? '?' : 'บรรจุ ' + d.pack + ' → ' + (Math.round(d.boxes * 100) / 100) + ' หีบ') + '</td></tr>').join('');
      return '<div class="oc ' + (o.include ? '' : 'skip ') + (o.warn.length ? 'warnrow' : '') + '" data-i="' + i + '">' +
        '<div class="oc-h"><input type="checkbox" data-f="include" ' + (o.include ? 'checked' : '') + ' title="ติ๊กเพื่อทำใบนี้"><span class="no">ออเดอร์ ' + esc(o.no) + '</span>' + tags.join('') + '</div>' +
        '<div class="oc-b">' +
        F('c6', 'ขนส่ง', 'transport', o.transport) + F('c4', 'ผู้รับ', 'name', o.name) + F('c2', 'จำนวน (0 = เว้นว่าง)', 'pieces', o.pieces, 'number') +
        F('c4', 'โทร', 'phone', o.phone) + F('c8', 'ที่อยู่', 'address', o.address) +
        '</div><div class="oc-f"><details><summary>รายการสินค้า · โน้ต</summary><div class="hint">โน้ต: ' + esc(o.note) + '</div><table>' + det + '</table></details></div></div>';
    }).join('');
    $('tbl').innerHTML = body;
    renderCf();
    stats();
  }

  // ---------- หน้าใบยืนยัน ----------
  const picked = () => orders.filter(o => o.seq !== '' && o.seq > 0).sort((a, b) => a.seq - b.seq);
  const nextSeq = () => picked().length ? Math.max.apply(null, picked().map(o => +o.seq)) + 1 : 1;
  function renumber() { picked().forEach((o, i) => { o.seq = i + 1; }); }

  const itemLines = o => o.detail.filter(d => d.qty).map(d => {
    const n = d.skip ? d.qty : d.unknown ? '?' : Math.ceil(d.boxes - 1e-9);
    return { name: d.name || d.sku, n: n, foc: !!d.skip };
  });

  function fillPickers() {
    const ts = [];
    orders.forEach(o => { const t = o.transport || '(ไม่ระบุขนส่ง)'; if (ts.indexOf(t) < 0) ts.push(t); });
    ts.sort((a, b) => a.localeCompare(b, 'th'));
    const cur = $('pkT').value;
    $('pkT').innerHTML = '<option value="">— ทุกขนส่ง —</option>' + ts.map(t => '<option>' + esc(t) + '</option>').join('');
    if (cur && ts.indexOf(cur) >= 0) $('pkT').value = cur;
    fillCustomers();
  }
  function fillCustomers() {
    const t = $('pkT').value;
    const list = orders.map((o, i) => [o, i])
      .filter(([o]) => !(o.seq !== '' && o.seq > 0))
      .filter(([o]) => !t || (o.transport || '(ไม่ระบุขนส่ง)') === t);
    $('pkC').innerHTML = list.length
      ? list.map(([o, i]) => '<option value="' + i + '">' + esc(o.name || '(ไม่มีชื่อ)') + ' · ออเดอร์ ' + esc(o.no) + ' · ' + (o.pieces > 0 ? o.pieces + ' ลัง' : 'ไม่ระบุจำนวน') + '</option>').join('')
      : '<option value="">— เพิ่มครบแล้ว —</option>';
    $('pkAdd').disabled = $('pkAddAll').disabled = !list.length;
  }
  function addOrder(i) { const o = orders[i]; if (o && !(o.seq !== '' && o.seq > 0)) o.seq = nextSeq(); }

  $('pkT').addEventListener('change', fillCustomers);
  $('pkAdd').addEventListener('click', () => { const v = $('pkC').value; if (v !== '') { addOrder(+v); renderCf(); } });
  $('pkAddAll').addEventListener('click', () => {
    Array.prototype.slice.call($('pkC').options).forEach(op => { if (op.value !== '') addOrder(+op.value); });
    renderCf();
  });

  function renderCf() {
    $('cfcard').hidden = !orders.length;
    $('cfempty').hidden = !!orders.length;
    fillPickers();
    const list = picked();
    $('cflist').innerHTML = list.length ? list.map((o, k) => {
      const i = orders.indexOf(o);
      const its = itemLines(o).map(x => esc(x.name) + (x.foc ? ' (แถม)' : '') + ' <b>' + x.n + ' ลัง</b>').join(' · ');
      return '<div class="cfrow" data-i="' + i + '">' +
        '<input type="number" min="1" data-f="seq" value="' + esc(o.seq) + '" title="ลำดับ">' +
        '<div class="mv"><button data-a="up"' + (k === 0 ? ' disabled' : '') + ' title="เลื่อนขึ้น">▲</button>' +
        '<button data-a="down"' + (k === list.length - 1 ? ' disabled' : '') + ' title="เลื่อนลง">▼</button></div>' +
        '<div class="d"><input type="text" data-f="dest" value="' + esc(o.dest) + '" placeholder="ส่งที่…">' +
        '<div class="w">' + esc(o.name) + ' · ออเดอร์ ' + esc(o.no) + '</div>' +
        '<div class="its">' + (its || '-') + '</div></div>' +
        '<div class="p">' + (o.pieces > 0 ? o.pieces : '–') + ' <small>ลัง</small></div>' +
        '<button class="rm" data-a="rm" title="เอาออก">ลบ</button></div>';
    }).join('') : '<p class="hint">ยังไม่ได้เลือกออเดอร์ไหนเข้าใบยืนยัน</p>';
    const n = list.length;
    const tot = list.reduce((a, o) => a + (+o.pieces || 0), 0);
    $('printConfirm').disabled = !n;
    $('cfmsg').textContent = n ? 'ในใบนี้ ' + n + ' ออเดอร์ · รวม ' + tot + ' ลัง' : 'เลือกออเดอร์เข้าใบยืนยันก่อน';
  }

  $('cflist').addEventListener('input', e => {
    const row = e.target.closest('[data-i]');
    if (!row) return;
    const o = orders[+row.dataset.i], f = e.target.dataset.f;
    if (f === 'seq') { o.seq = e.target.value === '' ? '' : (parseInt(e.target.value, 10) || ''); renderCf(); }
    else o[f] = e.target.value;
  });
  $('cflist').addEventListener('click', e => {
    const btn = e.target.closest('button[data-a]');
    if (!btn) return;
    const o = orders[+btn.closest('[data-i]').dataset.i], a = btn.dataset.a;
    const list = picked(), k = list.indexOf(o);
    if (a === 'rm') { o.seq = ''; renumber(); }
    else if (a === 'up' && k > 0) { const s = o.seq; o.seq = list[k - 1].seq; list[k - 1].seq = s; }
    else if (a === 'down' && k < list.length - 1) { const s = o.seq; o.seq = list[k + 1].seq; list[k + 1].seq = s; }
    renderCf();
  });

  function showPage(p) {
    $('pgL').hidden = p !== 'L';
    $('pgC').hidden = p !== 'C';
    $('tabL').classList.toggle('on', p === 'L');
    $('tabC').classList.toggle('on', p === 'C');
    window.scrollTo(0, 0);
  }
  $('tabL').addEventListener('click', () => showPage('L'));
  $('tabC').addEventListener('click', () => showPage('C'));

  function stats() {
    const n = orders.filter(o => o.include).length;
    const pcs = orders.filter(o => o.include).reduce((a, o) => a + (+o.pieces || 0), 0);
    $('stats').textContent = 'ออเดอร์ ' + orders.length + ' รายการ · จะทำใบปะหน้า ' + n + ' ใบ · รวม ' + pcs + ' ชิ้น';
    $('dlDocx').disabled = $('print').disabled = !n;
  }

  $('tbl').addEventListener('input', e => {
    const tr = e.target.closest('[data-i]');
    if (!tr) return;
    const o = orders[+tr.dataset.i], f = e.target.dataset.f;
    if (f === 'include') { o.include = e.target.checked; tr.classList.toggle('skip', !o.include); }
    else if (f === 'pieces') o[f] = parseInt(e.target.value || '0', 10) || 0;
    else if (f === 'seq') o[f] = e.target.value === '' ? '' : (parseInt(e.target.value, 10) || '');
    else if (f === 'transport') {
      if (o.dest === o.transport) o.dest = e.target.value;
      o[f] = e.target.value;
    }
    else o[f] = e.target.value;
    stats();
  });

  // ---------- label content ----------
  const chosen = () => orders.filter(o => o.include);
  const pieceText = o => (o.pieces > 0 ? o.pieces : '.......') + '  ชิ้น';
  const headText = o => (o.transport || 'ขนส่ง..............');

  function markDone() {
    const h = loadHist();
    chosen().forEach(o => { h[o.no] = { phone: o.phone, t: Date.now() }; });
    saveHist(h);
  }

  // ---------- print ----------
  function buildPrint() {
    $('labels').innerHTML = chosen().map(o =>
      '<div class="label"><div class="h">' + esc(headText(o)) + '&nbsp;&nbsp;' + esc(pieceText(o)) + '</div>' +
      (o.nosender ? '' : '<p>ผู้ส่ง ก้อย (MKS)&nbsp;&nbsp;โทร 0651899955</p>') +
      '<p>' + esc(o.name) + '</p><p>เบอร์ติดต่อ</p><p>' + esc(o.phone) + '</p><p>ที่อยู่จัดส่ง</p><p>' + esc(o.address) + '</p></div>'
    ).join('');
  }
  $('print').addEventListener('click', () => {
    buildPrint();
    markDone();
    $('msg').textContent = 'เลือก "บันทึกเป็น PDF" ในหน้าต่างพิมพ์ ขนาดกระดาษ A5 แนวนอน ไม่มีขอบ';
    printMode('labels');
  });

  // ---------- docx ----------
  $('dlDocx').addEventListener('click', async () => {
    const D = window.docx;
    if (!D) { $('msg').textContent = 'โหลดไลบรารี docx ไม่สำเร็จ (ต้องต่ออินเทอร์เน็ต) — ใช้ปุ่มพิมพ์/PDF แทนได้'; return; }
    const FONT = 'Tahoma';
    const run = (t, o = {}) => new D.TextRun({ text: t, font: FONT, size: o.size || 40, bold: !!o.bold });
    const para = (t, o = {}) => new D.Paragraph({ spacing: { after: o.after ?? 160 }, alignment: o.align, children: [run(t, o)] });
    const sections = chosen().map(x => ({
      properties: { page: { size: { width: 8391, height: 11906, orientation: D.PageOrientation.LANDSCAPE }, margin: { top: 700, bottom: 500, left: 900, right: 700 } } },
      children: [
        new D.Paragraph({ alignment: D.AlignmentType.CENTER, spacing: { after: 260 }, children: [run(headText(x) + '  ', { size: 56 }), run(pieceText(x), { size: 56 })] }),
        ...(x.nosender ? [] : [para('ผู้ส่ง ก้อย (MKS)  โทร 0651899955')]),
        para(x.name), para('เบอร์ติดต่อ'), para(x.phone), para('ที่อยู่จัดส่ง'), para(x.address),
      ],
    }));
    const doc = new D.Document({ styles: { default: { document: { run: { font: FONT, size: 40 } } } }, sections });
    const blob = await D.Packer.toBlob(doc);
    const d = new Date();
    const name = 'ใบปะหน้า_' + d.getDate() + '-' + (d.getMonth() + 1) + '_' + chosen().length + 'ใบ.docx';
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    markDone();
    $('msg').textContent = 'ดาวน์โหลดแล้ว: ' + name;
  });

  // ---------- print mode ----------
  function printMode(m) {
    document.body.classList.add('pm-' + m);
    const done = () => { document.body.classList.remove('pm-' + m); window.removeEventListener('afterprint', done); };
    window.addEventListener('afterprint', done);
    window.print();
  }

  // ---------- ใบยืนยันส่งมอบ ----------
  const thDate = () => new Date().toLocaleDateString('th-TH', { day: 'numeric', month: 'long', year: 'numeric' });
  function seqOrders() {
    return orders.filter(o => o.seq !== '' && o.seq > 0).sort((a, b) => a.seq - b.seq || String(a.no).localeCompare(String(b.no)));
  }
  $('autoSeq').addEventListener('click', () => {
    const list = chosen().slice().sort((a, b) => (a.dest || '').localeCompare(b.dest || '', 'th') || String(a.no).localeCompare(String(b.no)));
    orders.forEach(o => { o.seq = ''; });
    list.forEach((o, i) => { o.seq = i + 1; });
    renderCf();
  });
  $('clearSeq').addEventListener('click', () => { orders.forEach(o => { o.seq = ''; }); renderCf(); });
  $('printConfirm').addEventListener('click', () => {
    const list = seqOrders();
    if (!list.length) { $('cfmsg').textContent = 'ยังไม่มีออเดอร์ที่ใส่ลำดับ — กด "ใส่ลำดับอัตโนมัติ" หรือกรอกช่อง "ลำดับ" ก่อน'; return; }
    const total = list.reduce((a, o) => a + (+o.pieces || 0), 0);
    const driver = $('cfDriver').value.trim(), plate = $('cfPlate').value.trim(), dest = $('cfDest').value.trim();
    const meta = '<div>วันที่ ' + esc(thDate()) + '</div>' +
      '<div>คนขับรถ: ' + (esc(driver) || '.............................') + '</div>' +
      '<div>ทะเบียนรถ: ' + (esc(plate) || '................') + '</div>' +
      (dest ? '<div>ส่งที่: ' + esc(dest) + '</div>' : '');
    const items = o => o.detail.filter(d => d.qty).map(d => {
      const n = d.skip ? d.qty : d.unknown ? '?' : Math.ceil(d.boxes - 1e-9);
      return '<div class="it"><span>' + esc(d.name || d.sku) + (d.skip ? ' (แถม)' : '') + '</span><b>' + n + ' ลัง</b></div>';
    }).join('');
    const rows = list.map((o, i) =>
      '<div class="ord"><div class="seq">' + (i + 1) + '</div>' +
      '<div class="mid"><div class="top"><div><div class="dest">ส่งที่ ' + esc(o.dest || o.transport) + '</div>' +
      '<div class="who">' + esc(o.name) + ' · ' + esc(o.phone) + ' · ออเดอร์ ' + esc(o.no) + '</div></div>' +
      '<div class="cnt">' + (o.pieces > 0 ? o.pieces : '') + '<small>ลัง</small></div></div>' +
      '<div class="its">' + (items(o) || '-') + '</div></div>' +
      '<div class="sg"><span>ลงชื่อรับของ</span></div></div>').join('');
    $('confirm').innerHTML = '<div class="cf"><h2>ใบยืนยันการรับสินค้าไปส่ง</h2><div class="meta">' + meta + '</div>' + rows +
      '<div class="tot">รวมทั้งหมด ' + list.length + ' ใบ · <b>' + total + '</b> ลัง</div>' +
      '<p class="note">ข้าพเจ้าได้รับสินค้าตามรายการข้างต้นครบถ้วน และจะนำไปส่งตามลำดับที่ระบุ</p>' +
      '<div class="sigrow"><div class="sigbox"><div class="line"></div>ผู้ส่งมอบ (เมืองเกษตร)<br>วันที่ ....../....../......</div>' +
      '<div class="sigbox"><div class="line"></div>คนขับรถ / ผู้รับสินค้า<br>วันที่ ....../....../......</div></div></div>';
    $('cfmsg').textContent = 'เลือก "บันทึกเป็น PDF" ขนาด A4 แนวตั้ง';
    printMode('confirm');
  });

  // ---------- events ----------
  const drop = $('drop'), file = $('file');
  drop.addEventListener('click', () => file.click());
  file.addEventListener('change', () => file.files.length && readFiles(file.files));
  ['dragover', 'dragenter'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('over'); }));
  drop.addEventListener('drop', e => e.dataTransfer.files.length && readFiles(e.dataTransfer.files));
  $('mode').addEventListener('change', () => allRows.length && rebuild());
  $('hideDone').addEventListener('change', render);
})();
