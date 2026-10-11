// =====================================================================
//  CricLive charts - tiny SVG chart library (no external packages)
//   Charts.bar(el, spec)      vertical columns  (or horizontal: true)
//   Charts.grouped(el, spec)  grouped columns, 2-3 series
//   Charts.line(el, spec)     lines with crosshair tooltip
//  Every chart gets: hover tooltip, legend (2+ series), "Show data" table,
//  light + dark colours from the validated colour-blind-safe palette.
// =====================================================================
(function () {
  const NS = 'http://www.w3.org/2000/svg';
  const fmt = v => (typeof v === 'number' ? (Number.isInteger(v) ? v.toLocaleString('en-GB') : v.toLocaleString('en-GB', { maximumFractionDigits: 2 })) : v);
  const escH = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const slot = i => `var(--series-${(i % 4) + 1})`;

  function niceScale(max, ticks = 4) {
    if (!(max > 0)) return { max: 1, step: 1 };
    const raw = max / ticks, mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => s >= raw);
    return { max: Math.ceil(max / step) * step, step };
  }
  function el(tag, attrs, parent) {
    const e = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs || {})) e.setAttribute(k, v);
    if (parent) parent.appendChild(e);
    return e;
  }
  function text(parent, x, y, str, attrs = {}) {
    const t = el('text', { x, y, class: 'cl-axis', ...attrs }, parent);
    t.textContent = str;
    return t;
  }
  // vertical bar: 4px rounded data end, square at the baseline
  function vbar(x, y, w, h) {
    const r = Math.min(4, w / 2, h);
    return `M${x},${y + h}L${x},${y + r}Q${x},${y} ${x + r},${y}L${x + w - r},${y}Q${x + w},${y} ${x + w},${y + r}L${x + w},${y + h}Z`;
  }
  function hbar(x, y, w, h) {
    const r = Math.min(4, h / 2, w);
    return `M${x},${y}L${x + w - r},${y}Q${x + w},${y} ${x + w},${y + r}L${x + w},${y + h - r}Q${x + w},${y + h} ${x + w - r},${y + h}L${x},${y + h}Z`;
  }

  // ---- frame: title, legend, svg, tooltip, data table toggle
  // charts animate (bars grow, lines draw) the first time they scroll into view
  const io = 'IntersectionObserver' in window ? new IntersectionObserver(es => es.forEach(e => { if (e.isIntersecting) { e.target.classList.remove('cl-wait'); io.unobserve(e.target); } }), { rootMargin: '0px 0px -8% 0px' }) : null;
  function frame(host, spec, series) {
    const first = !host.dataset.drawn;
    host.dataset.drawn = 1;
    host.innerHTML = '';
    host.classList.add('cl-chart');
    host.classList.toggle('cl-anim', first);
    if (first && io) { host.classList.add('cl-wait'); io.observe(host); }
    if (spec.title) { const h = document.createElement('div'); h.className = 'cl-title'; h.textContent = spec.title; host.appendChild(h); }
    if (spec.subtitle) { const h = document.createElement('div'); h.className = 'cl-sub'; h.textContent = spec.subtitle; host.appendChild(h); }
    if (series && series.length > 1) {
      const lg = document.createElement('div'); lg.className = 'cl-legend';
      lg.innerHTML = series.map((s, i) => `<span><i style="background:${slot(s.slot ?? i)}"></i>${escH(s.name)}</span>`).join('');
      host.appendChild(lg);
    }
    const wrap = document.createElement('div'); wrap.className = 'cl-plot'; host.appendChild(wrap);
    const tip = document.createElement('div'); tip.className = 'cl-tip'; tip.hidden = true; wrap.appendChild(tip);
    const W = Math.max(260, wrap.clientWidth || host.clientWidth || 600);
    const svg = el('svg', { width: W, height: spec.height || 240, viewBox: `0 0 ${W} ${spec.height || 240}`, role: 'img', 'aria-label': spec.title || 'chart' }, wrap);
    return { wrap, svg, tip, W, H: spec.height || 240 };
  }
  function showTip(f, html, x, y) {
    f.tip.innerHTML = html; f.tip.hidden = false;
    const tw = f.tip.offsetWidth, th = f.tip.offsetHeight;
    f.tip.style.left = Math.max(0, Math.min(f.W - tw, x - tw / 2)) + 'px';
    f.tip.style.top = Math.max(0, y - th - 10) + 'px';
  }
  function dataTable(host, headers, rows) {
    const d = document.createElement('details'); d.className = 'cl-data';
    d.innerHTML = `<summary>Show data</summary><div class="table-wrap"><table><tr>${headers.map((h, i) => `<th class="${i ? 'num' : ''}">${escH(h)}</th>`).join('')}</tr>
      ${rows.map(r => `<tr>${r.map((c, i) => `<td class="${i ? 'num' : ''}">${escH(fmt(c))}</td>`).join('')}</tr>`).join('')}</table></div>`;
    host.appendChild(d);
  }
  function empty(host, spec) {
    host.innerHTML = `${spec.title ? `<div class="cl-title">${escH(spec.title)}</div>` : ''}<div class="cl-empty">${escH(spec.empty || 'No data yet')}</div>`;
  }
  function gridY(f, pad, scale, plotH) {
    for (let v = 0; v <= scale.max + 1e-9; v += scale.step) {
      const y = pad.t + plotH - (v / scale.max) * plotH;
      el('line', { x1: pad.l, x2: f.W - pad.r, y1: y, y2: y, class: v === 0 ? 'cl-base' : 'cl-grid' }, f.svg);
      text(f.svg, pad.l - 6, y + 4, fmt(Math.round(v * 100) / 100), { 'text-anchor': 'end' });
    }
  }
  function xLabels(f, labels, x0, band, y, pad) {
    const every = Math.max(1, Math.ceil(labels.length / Math.floor((f.W - pad.l - pad.r) / 48)));
    labels.forEach((l, i) => { if (i % every === 0) text(f.svg, x0 + band * i + band / 2, y, l, { 'text-anchor': 'middle' }); });
  }
  function responsive(host, draw) {
    draw();
    if (window.ResizeObserver) {
      let w = host.clientWidth, t;
      new ResizeObserver(() => { if (Math.abs(host.clientWidth - w) > 20) { w = host.clientWidth; clearTimeout(t); t = setTimeout(draw, 120); } }).observe(host);
    }
  }

  // ------------------------------------------------------------ bar
  function bar(host, spec) {
    const data = spec.data || [];
    if (!data.length || data.every(d => !d.value)) return empty(host, spec);
    const draw = () => {
      if (spec.horizontal) return hBars(host, spec, data);
      const f = frame(host, spec);
      const pad = { t: 18, r: 10, b: 28, l: 40 };
      const plotH = f.H - pad.t - pad.b, plotW = f.W - pad.l - pad.r;
      const scale = niceScale(Math.max(...data.map(d => d.value)));
      gridY(f, pad, scale, plotH);
      const band = plotW / data.length, bw = Math.min(24, band * 0.7);
      data.forEach((d, i) => {
        const h = (d.value / scale.max) * plotH, x = pad.l + band * i + (band - bw) / 2, y = pad.t + plotH - h;
        if (h > 0) el('path', { d: vbar(x, y, bw, h), fill: d.color || slot(spec.slot || 0), class: 'cl-bar' + (d.muted ? ' cl-muted' : ''), style: `--bd:${i * 35}ms` }, f.svg);
        if (spec.valueLabels && data.length <= 12) text(f.svg, x + bw / 2, y - 5, (spec.valueFmt || fmt)(d.value), { 'text-anchor': 'middle', class: 'cl-val' });
        const hit = el('rect', { x: pad.l + band * i, y: pad.t, width: band, height: plotH, class: 'cl-hit' }, f.svg);
        hit.addEventListener('mousemove', () => showTip(f, `<b>${escH(d.tip || d.label)}</b><br>${escH(spec.valueName || 'Value')}: <b>${escH((spec.valueFmt || fmt)(d.value))}</b>${d.extra ? '<br>' + escH(d.extra) : ''}`, x + bw / 2, y));
        hit.addEventListener('mouseleave', () => (f.tip.hidden = true));
        if (d.href) { hit.style.cursor = 'pointer'; hit.addEventListener('click', () => (location.href = d.href)); }
      });
      xLabels(f, data.map(d => d.label), pad.l, band, f.H - 8, pad);
      if (spec.yTitle) text(f.svg, pad.l, 10, spec.yTitle, { class: 'cl-axis cl-ytitle' });
      dataTable(host, [spec.labelName || 'Item', spec.valueName || 'Value'], data.map(d => [d.tip || d.label, d.value]));
    };
    responsive(host, draw);
  }

  function hBars(host, spec, data) {
    const rowH = 30;
    spec = { ...spec, height: data.length * rowH + 14 };
    const f = frame(host, spec);
    const labelW = Math.min(190, f.W * 0.42), pad = { l: labelW + 8, r: 46, t: 6 };
    const max = Math.max(...data.map(d => d.value)) || 1;
    const plotW = f.W - pad.l - pad.r;
    data.forEach((d, i) => {
      const y = pad.t + i * rowH, w = Math.max(0, (d.value / max) * plotW), bh = 16;
      let lab = d.label;
      const t = text(f.svg, labelW, y + rowH / 2 + 4, lab, { 'text-anchor': 'end', class: 'cl-axis cl-hlabel' });
      while (t.getComputedTextLength && t.getComputedTextLength() > labelW - 4 && lab.length > 4) { lab = lab.slice(0, -2); t.textContent = lab + '…'; }
      if (w > 0) el('path', { d: hbar(pad.l, y + (rowH - bh) / 2, w, bh), fill: d.color || slot(spec.slot || 0), class: 'cl-hbar', style: `--bd:${i * 45}ms` }, f.svg);
      text(f.svg, pad.l + w + 6, y + rowH / 2 + 4, (spec.valueFmt || fmt)(d.value), { class: 'cl-val' });
      const hit = el('rect', { x: 0, y, width: f.W, height: rowH, class: 'cl-hit' }, f.svg);
      hit.addEventListener('mousemove', () => showTip(f, `<b>${escH(d.tip || d.label)}</b><br>${escH(spec.valueName || 'Value')}: <b>${escH((spec.valueFmt || fmt)(d.value))}</b>${d.extra ? '<br>' + escH(d.extra) : ''}`, pad.l + w, y + 4));
      hit.addEventListener('mouseleave', () => (f.tip.hidden = true));
      if (d.href) { hit.style.cursor = 'pointer'; hit.addEventListener('click', () => (location.href = d.href)); }
    });
    dataTable(host, [spec.labelName || 'Item', spec.valueName || 'Value'], data.map(d => [d.tip || d.label, d.value]));
  }

  // ------------------------------------------------------------ grouped columns
  function grouped(host, spec) {
    const { labels = [], series = [] } = spec;
    if (!labels.length || series.every(s => s.values.every(v => !v))) return empty(host, spec);
    const draw = () => {
      const f = frame(host, spec, series);
      const pad = { t: 14, r: 10, b: 28, l: 40 };
      const plotH = f.H - pad.t - pad.b, plotW = f.W - pad.l - pad.r;
      const scale = niceScale(Math.max(...series.flatMap(s => s.values)));
      gridY(f, pad, scale, plotH);
      const band = plotW / labels.length, bw = Math.min(20, (band * 0.75 - 2 * (series.length - 1)) / series.length);
      const groupW = bw * series.length + 2 * (series.length - 1);
      labels.forEach((l, i) => {
        const gx = pad.l + band * i + (band - groupW) / 2;
        series.forEach((s, j) => {
          const v = s.values[i] || 0, h = (v / scale.max) * plotH;
          if (h > 0) el('path', { d: vbar(gx + j * (bw + 2), pad.t + plotH - h, bw, h), fill: slot(s.slot ?? j), class: 'cl-bar', style: `--bd:${i * 30 + j * 80}ms` }, f.svg);
        });
        const hit = el('rect', { x: pad.l + band * i, y: pad.t, width: band, height: plotH, class: 'cl-hit' }, f.svg);
        hit.addEventListener('mousemove', () => {
          const top = pad.t + plotH - (Math.max(...series.map(s => s.values[i] || 0)) / scale.max) * plotH;
          showTip(f, `<b>${escH((spec.tips && spec.tips[i]) || l)}</b>` + series.map((s, j) => `<div class="cl-row"><i style="background:${slot(s.slot ?? j)}"></i>${escH(s.name)}: <b>${escH((spec.valueFmt || fmt)(s.values[i] || 0))}</b></div>`).join(''), pad.l + band * i + band / 2, top);
        });
        hit.addEventListener('mouseleave', () => (f.tip.hidden = true));
      });
      xLabels(f, labels, pad.l, band, f.H - 8, pad);
      if (spec.yTitle) text(f.svg, pad.l, 10, spec.yTitle, { class: 'cl-axis cl-ytitle' });
      dataTable(host, [spec.labelName || 'Item', ...series.map(s => s.name)], labels.map((l, i) => [(spec.tips && spec.tips[i]) || l, ...series.map(s => s.values[i] || 0)]));
    };
    responsive(host, draw);
  }

  // ------------------------------------------------------------ line
  function line(host, spec) {
    const { labels = [], series = [] } = spec;
    if (!labels.length) return empty(host, spec);
    const draw = () => {
      const f = frame(host, spec, series);
      const pad = { t: 14, r: 16, b: 28, l: 40 };
      const plotH = f.H - pad.t - pad.b, plotW = f.W - pad.l - pad.r;
      const vals = series.flatMap(s => s.values.filter(v => v != null));
      const scale = niceScale(Math.max(...vals, 0));
      gridY(f, pad, scale, plotH);
      const n = labels.length;
      const X = i => pad.l + (n === 1 ? plotW / 2 : (i / (n - 1)) * plotW);
      const Y = v => pad.t + plotH - (v / scale.max) * plotH;
      series.forEach((s, j) => {
        const pts = s.values.map((v, i) => (v == null ? null : [X(i), Y(v)])).filter(Boolean);
        if (spec.area && series.length === 1 && pts.length > 1) el('path', { d: `M${pts[0][0]},${Y(0)}L${pts.map(p => p.join(',')).join('L')}L${pts[pts.length - 1][0]},${Y(0)}Z`, fill: slot(s.slot ?? j), class: 'cl-area' }, f.svg);
        if (pts.length > 1) el('path', { d: 'M' + pts.map(p => p.join(',')).join('L'), stroke: slot(s.slot ?? j), class: 'cl-line', pathLength: 1, style: `--bd:${j * 250}ms` }, f.svg);
        const last = pts[pts.length - 1];
        if (last) el('circle', { cx: last[0], cy: last[1], r: 4, fill: slot(s.slot ?? j), class: 'cl-dot', style: `--bd:${j * 250}ms` }, f.svg);
        (s.markers || []).forEach(m => { if (s.values[m.i] != null) el('circle', { cx: X(m.i), cy: Y(s.values[m.i]), r: 4.5, fill: slot(s.slot ?? j), class: 'cl-dot cl-marker', style: `--bd:${j * 250}ms` }, f.svg); });
      });
      const every = Math.max(1, Math.ceil(n / Math.floor(plotW / 44)));
      labels.forEach((l, i) => { if (i % every === 0 || i === n - 1) text(f.svg, X(i), f.H - 8, l, { 'text-anchor': 'middle' }); });
      if (spec.yTitle) text(f.svg, pad.l, 10, spec.yTitle, { class: 'cl-axis cl-ytitle' });
      // crosshair
      const cross = el('line', { y1: pad.t, y2: pad.t + plotH, class: 'cl-cross', visibility: 'hidden' }, f.svg);
      const hit = el('rect', { x: pad.l - 8, y: pad.t, width: plotW + 16, height: plotH, class: 'cl-hit' }, f.svg);
      hit.addEventListener('mousemove', e => {
        const box = f.svg.getBoundingClientRect();
        const mx = (e.clientX - box.left) * (f.W / box.width);
        const i = Math.max(0, Math.min(n - 1, Math.round(((mx - pad.l) / plotW) * (n - 1))));
        cross.setAttribute('x1', X(i)); cross.setAttribute('x2', X(i)); cross.setAttribute('visibility', 'visible');
        const top = Math.min(...series.map(s => (s.values[i] == null ? Infinity : Y(s.values[i]))));
        showTip(f, `<b>${escH((spec.tips && spec.tips[i]) || labels[i])}</b>` + series.map((s, j) => s.values[i] == null ? '' :
          `<div class="cl-row"><i style="background:${slot(s.slot ?? j)}"></i>${escH(s.name)}: <b>${escH((spec.valueFmt || fmt)(s.values[i]))}</b>${s.notes && s.notes[i] ? ' ' + escH(s.notes[i]) : ''}</div>`).join(''), X(i), isFinite(top) ? top : pad.t);
      });
      hit.addEventListener('mouseleave', () => { f.tip.hidden = true; cross.setAttribute('visibility', 'hidden'); });
      dataTable(host, [spec.labelName || 'Point', ...series.map(s => s.name)], labels.map((l, i) => [(spec.tips && spec.tips[i]) || l, ...series.map(s => s.values[i] ?? '-')]));
    };
    responsive(host, draw);
  }

  window.Charts = { bar, grouped, line };
})();
