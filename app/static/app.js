/* Ristruttura730 — frontend vanilla JS */

const state = {
  anno: null,
  soloPagate: false,
  years: [],
  persons: [],
  suppliers: [],
  ecoCats: [],
  expenses: [],     // spese dell'anno selezionato
  report: null,     // {tutte, solo_pagate}
  settings: null,
  personYears: {},  // person_id -> {reddito, ritenute, detrazioni_pregresse}
  editingSupplier: null,
  sortSpese: { key: 'data', dir: 1 },
};

function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  localStorage.setItem('theme', t);
  el('btn-theme').textContent = t === 'dark' ? '☀️' : '🌙';
  Chart.defaults.color = t === 'dark' ? '#9aa4b2' : '#666';
  Chart.defaults.borderColor = t === 'dark' ? '#262d37' : '#e7eaef';
}

const charts = {};

const eur = n => new Intl.NumberFormat('it-IT', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(n || 0);
const eur2 = n => new Intl.NumberFormat('it-IT', { style: 'currency', currency: 'EUR' }).format(n || 0);
const pct = n => (100 * n).toLocaleString('it-IT', { maximumFractionDigits: 1 }) + '%';
const el = id => document.getElementById(id);

let toastTimer = null;
function toast(msg) {
  const t = el('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 1600);
}

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    alert(err.detail || `Errore ${res.status}`);
    throw new Error(`${method} ${url} -> ${res.status}`);
  }
  if (method !== 'GET') toast('✓ Salvato');
  return res.json();
}

/* ---------------- caricamento ---------------- */

async function loadGlobal() {
  [state.years, state.persons, state.suppliers, state.ecoCats, state.priorDeductions] = await Promise.all([
    api('GET', '/api/years'),
    api('GET', '/api/persons'),
    api('GET', '/api/suppliers'),
    api('GET', '/api/eco-categories'),
    api('GET', '/api/prior-deductions'),
  ]);
  if (!state.anno || !state.years.includes(state.anno)) {
    state.anno = state.years[state.years.length - 1];
  }
}

async function loadYear() {
  const a = state.anno;
  const [expenses, allExpenses, report, settings, pys] = await Promise.all([
    api('GET', `/api/expenses?anno=${a}`),
    api('GET', '/api/expenses'),
    api('GET', `/api/report/${a}`),
    api('GET', `/api/settings/${a}`),
    api('GET', `/api/person-years/${a}`),
  ]);
  state.expenses = expenses;
  state.allExpenses = allExpenses;
  state.report = report;
  state.settings = settings;
  state.personYears = Object.fromEntries(pys.map(r => [r.person_id, r]));
}

async function refresh({ global = false } = {}) {
  if (global) await loadGlobal();
  await loadYear();
  renderAll();
}

/* ---------------- rendering ---------------- */

function activeReport() {
  return state.soloPagate ? state.report.solo_pagate : state.report.tutte;
}

function visibleExpenses() {
  return state.soloPagate ? state.expenses.filter(e => e.pagata) : state.expenses;
}

function renderAll() {
  renderYearSelector();
  renderWarnings();
  renderDashboard();
  renderSpese();
  renderFornitori();
  render730();
  renderConfig();
}

function renderYearSelector() {
  const sel = el('sel-anno');
  sel.innerHTML = state.years.map(y => `<option ${y === state.anno ? 'selected' : ''}>${y}</option>`).join('');
}

const dismissedWarnings = new Set();

function renderWarnings() {
  const w = activeReport().warnings;
  state.currentWarnings = w;
  el('warnings').innerHTML = w.map((t, i) =>
    dismissedWarnings.has(t) ? '' :
    `<div class="warn">⚠️ <span>${t}</span><button class="warn-close" onclick="dismissWarning(${i})" title="Nascondi">✕</button></div>`
  ).join('');
}

window.dismissWarning = i => {
  dismissedWarnings.add(state.currentWarnings[i]);
  renderWarnings();
};

/* ---- dashboard ---- */

// Card di un bonus (tetto sull'unità immobiliare).
//   spesaCategoria: somma di TUTTE le spese del bonus (anche non detraibili)
//   detraibile: somma delle spese del bonus col flag detraibile, già tagliata al tetto
function capCard(titolo, spesaCategoria, detraibile, tetto, aliquota, extra = '') {
  const EPS = 0.005;
  const residuo = Math.max(0, tetto - detraibile);
  const pctResiduo = tetto > 0 ? residuo / tetto : 0;
  const recupero = detraibile * aliquota;
  const pctRecupero = spesaCategoria > 0 ? recupero / spesaCategoria : 0;
  const utilizzo = tetto > 0 ? Math.min(1, detraibile / tetto) : 0;
  const catOver = spesaCategoria > tetto + EPS;   // spesa di categoria oltre il cap
  const detrFull = detraibile >= tetto - EPS;     // detraibile al tetto
  const residuoZero = residuo <= EPS;
  const aliqPct = pct(aliquota);
  return `<div class="cap-card">
    <h5 title="Limiti del bonus sull'unità immobiliare (condivisi tra i comproprietari)">${titolo}</h5>
    <div class="big ${catOver ? 'saldo-neg' : ''}" title="Somma di tutte le spese con questo bonus, detraibili e non. Rosso se supera il tetto.">Spesa di categoria ${eur(spesaCategoria)}</div>
    <div class="sub" title="Solo le spese col flag detraibile (bonifico parlante), tagliate al tetto dell'unità. Rosso quando tocca il tetto.">↳ Di cui detraibile <strong class="${detrFull ? 'saldo-neg' : ''}">${eur(detraibile)}</strong> / ${eur(tetto)}${extra}</div>
    <div class="sub" title="Tetto − detraibile: quanto puoi ancora fatturare in detrazione. Rosso a zero.">Residuo detraibile <strong class="${residuoZero ? 'saldo-neg' : ''}">${eur(residuo)}</strong> · ${pct(pctResiduo)}</div>
    <div class="sub" title="${aliqPct} della spesa detraibile (detrazione totale in 10 anni). La % è sul totale della spesa di categoria.">Recupero con Bonus <strong>${eur(recupero)}</strong> · ${pct(pctRecupero)} della spesa</div>
    <div class="sub" style="margin-top:.4rem" title="Quota di tetto già consumata dalle spese detraibili">Utilizzo incentivo</div>
    <div class="bar"><div class="${detrFull ? 'over' : ''}" style="width:${utilizzo * 100}%"></div></div>
  </div>`;
}

// Card del tetto art. 16-ter (per persona, sulla rata annua di spesa).
function cap16terCard(p) {
  const EPS = 0.005;
  const cap = p.cap_16ter;
  const spesa = p.rata_spesa_16ter;                 // rata annua soggetta al tetto
  const spesaShown = Math.min(spesa, cap);
  const residuo = Math.max(0, cap - spesa);
  const pctResiduo = cap > 0 ? residuo / cap : 0;
  const utilizzo = cap > 0 ? Math.min(1, spesa / cap) : 0;
  const full = spesa >= cap - EPS;
  const residuoZero = residuo <= EPS;
  const pregr = p.pregresse_16ter_spesa
    ? ` <span class="muted">(di cui pregresse ${eur(p.pregresse_16ter_spesa)})</span>` : '';
  return `<div class="cap-card">
    <h5 title="Reddito > 75k: la rata annua di spesa detraibile (spesa/10) è limitata. Cap personale, non per unità.">Tetto 16-ter — ${p.nome}</h5>
    <div class="big ${full ? 'saldo-neg' : ''}" title="Somma delle quote annue di spesa detraibile di tutti i bonus (rata = spesa/10), incl. rate da anni precedenti dal 2025. Tagliata al tetto, rossa al raggiungimento.">Spesa detraibile ${eur(spesaShown)} / ${eur(cap)}${pregr}</div>
    <div class="sub" title="Tetto − spesa: quanta rata annua di spesa detraibile puoi ancora aggiungere. Rosso a zero.">Residuo detraibile <strong class="${residuoZero ? 'saldo-neg' : ''}">${eur(residuo)}</strong> · ${pct(pctResiduo)}</div>
    <div class="sub" style="margin-top:.4rem" title="Quota di tetto già consumata (opposto del residuo)">Utilizzo detraibilità</div>
    <div class="bar"><div class="${full ? 'over' : ''}" style="width:${utilizzo * 100}%"></div></div>
  </div>`;
}

function renderDashboard() {
  const r = activeReport();
  // spesa totale per bonus: include anche le spese senza flag detraibile
  const lordoRistr = visibleExpenses().filter(e => e.bonus_type === 'ristrutturazione').reduce((s, e) => s + e.importo, 0);
  const lordoMobili = visibleExpenses().filter(e => e.bonus_type === 'mobili').reduce((s, e) => s + e.importo, 0);
  const lordoEcoCat = {};
  for (const e of visibleExpenses()) {
    if (e.bonus_type !== 'ecobonus') continue;
    const k = String(e.eco_category_id ?? 'null');
    lordoEcoCat[k] = (lordoEcoCat[k] || 0) + e.importo;
  }

  const detrDi = alloc => Object.values(alloc).reduce((s, x) => s + x.detraibile, 0);
  const detrRistr = detrDi(r.ristrutturazione.per_persona);
  const detrMobili = detrDi(r.mobili.per_persona);
  let bonusHtml = capCard('Bonus Ristrutturazione', lordoRistr, detrRistr, r.ristrutturazione.tetto, r.aliquota);
  bonusHtml += capCard('Bonus Mobili', lordoMobili, detrMobili, r.mobili.tetto, r.aliquota);
  let detrEco = 0;
  for (const [cid, cat] of Object.entries(r.ecobonus)) {
    if (!cat.tetto_spesa) continue;
    const det = detrDi(cat.per_persona);
    detrEco += det;
    bonusHtml += capCard(`Ecobonus — ${cat.nome}`, lordoEcoCat[cid] || 0, det, cat.tetto_spesa, r.aliquota,
      ` <span class="muted">(detr. max ${eur(cat.massimale_detrazione)})</span>`);
  }
  for (const p of Object.values(r.persone)) {
    if (p.cap_16ter != null) bonusHtml += cap16terCard(p);
  }

  // card Riepilogo appartamento (in testa alla striscia, sempre visibile)
  const spesaTotale = visibleExpenses().reduce((s, e) => s + e.importo, 0);
  const spesaDetraibile = visibleExpenses().filter(e => e.detraibile).reduce((s, e) => s + e.importo, 0);
  // recupero EFFETTIVO: detrazione decennale già ridotta da tetti unità, 16-ter e capienza IRPEF
  const recupero10y = Object.values(r.persone).reduce((s, p) => s + p.detrazione_decennale_effettiva, 0);
  const recuperoLordo = (detrRistr + detrMobili + detrEco) * r.aliquota; // somma dei "Recupero con Bonus"
  const perso = recuperoLordo - recupero10y;
  const riepilogoHtml = `<div class="cap-card">
    <h5 title="Sintesi dell'intero appartamento per l'anno selezionato">Riepilogo appartamento</h5>
    <div class="big" title="Somma di tutte le spese, di qualsiasi bonus e a prescindere dalla detraibilità">${eur2(spesaTotale)}</div>
    <div class="sub" title="Somma di tutte le spese, di qualsiasi bonus e a prescindere dalla detraibilità">Spesa totale</div>
    <div class="sub" title="Somma delle spese col flag detraibile, di qualsiasi bonus (non ancora tagliata ai tetti)">Spesa detraibile: <strong>${eur2(spesaDetraibile)}</strong></div>
    <div class="sub" title="Detrazione effettivamente recuperabile in 10 anni: somma dei 'Recupero con Bonus' ridotta dal tetto 16-ter e dalla capienza IRPEF di ciascuna persona (a redditi costanti).">Recupero in 10 anni: <strong class="saldo-pos">${eur2(recupero10y)}</strong>${perso > 0.005
      ? ` <span class="muted">(lordo ${eur2(recuperoLordo)}, persi ${eur2(perso)})</span>` : ''}</div>
  </div>`;

  el('dash-caps').innerHTML = riepilogoHtml + bonusHtml;

  // torta fornitori
  const PALETTE = ['#2563eb', '#16a34a', '#f59e0b', '#8b5cf6', '#ec4899', '#14b8a6', '#f97316', '#0ea5e9', '#dc2626', '#64748b'];
  const bySupplier = {};
  for (const e of visibleExpenses()) bySupplier[e.supplier_nome] = (bySupplier[e.supplier_nome] || 0) + e.importo;
  makeChart('chart-fornitori', {
    type: 'doughnut',
    data: {
      labels: Object.keys(bySupplier),
      datasets: [{ data: Object.values(bySupplier), backgroundColor: PALETTE, borderWidth: 1 }],
    },
    options: {
      plugins: {
        legend: { position: window.innerWidth < 700 ? 'bottom' : 'right' },
        tooltip: { callbacks: { label: c => `${c.label}: ${eur2(c.parsed)}` } },
      },
    },
  });

  const persone = Object.values(r.persone);

  renderPreviste();

  // timeline cumulata per mese: pagato vs totale previsto
  const mesi = ['gen', 'feb', 'mar', 'apr', 'mag', 'giu', 'lug', 'ago', 'set', 'ott', 'nov', 'dic'];
  const cumPagato = Array(12).fill(0), cumTotale = Array(12).fill(0);
  for (const e of state.expenses) {
    const m = Number(e.data.slice(5, 7)) - 1;
    cumTotale[m] += e.importo;
    if (e.pagata) cumPagato[m] += e.importo;
  }
  for (let i = 1; i < 12; i++) { cumPagato[i] += cumPagato[i - 1]; cumTotale[i] += cumTotale[i - 1]; }
  makeChart('chart-timeline', {
    type: 'line',
    data: {
      labels: mesi,
      datasets: [
        { label: 'Pagato (cumulato)', data: cumPagato, borderColor: '#2563eb', backgroundColor: 'rgba(37,99,235,.15)', fill: true, tension: .2 },
        { label: 'Totale incl. da pagare', data: cumTotale, borderColor: '#f59e0b', borderDash: [6, 4], fill: false, tension: .2 },
      ],
    },
    options: {
      scales: { y: { beginAtZero: true } },
      plugins: { tooltip: { callbacks: { label: c => `${c.dataset.label}: ${eur2(c.parsed.y)}` } } },
    },
  });

  // riepilogo per persona
  const usatoEcoCat = {};
  for (const [cid, c] of Object.entries(r.ecobonus)) {
    usatoEcoCat[cid] = Object.values(c.per_persona).reduce((s, x) => s + x.spesa, 0);
  }
  let ecoResUnit = 0, ecoSenzaMassimale = 'null' in usatoEcoCat;
  for (const cat of state.ecoCats) {
    if (!cat.massimale_detrazione) { ecoSenzaMassimale = true; continue; }
    ecoResUnit += Math.max(0, cat.massimale_detrazione / r.aliquota - (usatoEcoCat[cat.id] || 0));
  }

  el('dash-residui').innerHTML = Object.entries(r.persone).map(([pid, p]) => {
    const ecoSpesa = Object.values(r.ecobonus).reduce((s, c) => s + (c.per_persona[pid]?.spesa || 0), 0);
    const head = p.residuo_fatturabile.headroom_personale;
    const ecoRes = head != null ? Math.min(ecoResUnit, head) : ecoResUnit;
    const maxFruibile = Math.min(p.cap_16ter != null ? p.cap_16ter * r.aliquota : Infinity, p.irpef_lorda);
    const riga = (k, v, extra = '', tip = '') => `<div class="sub"${tip ? ` title="${tip}"` : ''}>${k}: <strong>${v}</strong>${extra}</div>`;
    return `<div class="cap-card" style="margin-bottom:.7rem">
      <h5 title="Vincoli e risultato fiscale di ${p.nome} per l'anno selezionato">${p.nome}</h5>
      ${p.cap_16ter != null ? riga('Tetto annuo spese detraibili (art. 16-ter)', eur2(p.cap_16ter), '',
        'Reddito > 75k: massimo di rata annua di spesa detraibile (spesa/10) ammessa nell\'anno. Cap personale.') : ''}
      <hr class="riga-sep">
      ${riga('Capienza IRPEF annua', eur2(p.irpef_lorda), '',
        'IRPEF lorda dell\'anno: è il tetto massimo di detrazioni che si possono usare; l\'eccedenza è persa.')}
      ${riga('Detrazione massima fruibile/anno', eur2(maxFruibile), '',
        'Il minore tra capienza IRPEF e (se applicabile) il tetto 16-ter convertito in detrazione (cap × aliquota).')}
      <hr class="riga-sep">
      ${riga('Ristrutturazione già fatturato', eur2(p.spese.ristrutturazione.spesa), '',
        'Quota di spesa ristrutturazione già intestata a questa persona (50/50 o singola).')}
      ${riga('Ristrutturazione ancora fatturabile', eur(p.residuo_fatturabile.ristrutturazione), '',
        'Quanto puoi ancora farti fatturare restando entro il tetto dell\'unità (96k) e i limiti personali.')}
      ${riga('Mobili già fatturato', eur2(p.spese.mobili.spesa), '', 'Quota di spesa bonus mobili di questa persona.')}
      ${riga('Mobili ancora fatturabile', eur(p.residuo_fatturabile.mobili), '',
        'Spazio residuo entro il tetto mobili (5k) e i limiti personali.')}
      ${riga('Ecobonus già fatturato', eur2(ecoSpesa), '', 'Quota di spesa ecobonus di questa persona.')}
      ${riga('Ecobonus ancora fatturabile', eur(ecoRes), ecoSenzaMassimale ? ' <span class="muted">(+ categorie senza massimale)</span>' : '',
        'Spazio residuo entro i massimali eco delle categorie e i limiti personali.')}
      <hr class="riga-sep">
      ${riga('Recupero in 10 anni', eur2(p.detrazione_decennale_effettiva),
        p.detrazione_decennale - p.detrazione_decennale_effettiva > 0.005
          ? ` <span class="muted">(teorico ${eur2(p.detrazione_decennale)})</span>` : '',
        'Detrazione effettiva sui 10 anni (a redditi costanti), già ridotta da 16-ter e capienza IRPEF. Il teorico ignora la capienza.')}
      <div class="sub" title="Conguaglio del 730 di un singolo anno: ritenute del sostituto − IRPEF netta (lorda meno la rata di detrazione dell'anno e le pregresse). Positivo = rimborso, negativo = da versare. Riguarda solo l'anno, non i 10 anni di detrazione.">${p.saldo_730 >= 0 ? 'Rimborso' : 'Debito'} 730 annuo stimato: <strong class="${p.saldo_730 >= 0 ? 'saldo-pos' : 'saldo-neg'}">${eur2(Math.abs(p.saldo_730))}</strong></div>
    </div>`;
  }).join('');
}

function makeChart(id, cfg) {
  if (charts[id]) charts[id].destroy();
  charts[id] = new Chart(el(id), cfg);
}

/* vista "da pagare": spese non pagate scadute + prossimi 3 mesi (tutti gli anni) */
function renderPreviste() {
  const MESI = ['gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno',
    'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre'];
  const oggi = new Date().toISOString().slice(0, 10);
  const fine = new Date();
  fine.setMonth(fine.getMonth() + 4, 1); // inizio del 4° mese successivo = fine orizzonte
  const fineISO = fine.toISOString().slice(0, 10);

  const unpaid = (state.allExpenses || []).filter(e => !e.pagata).sort((a, b) => a.data.localeCompare(b.data));
  const scadute = unpaid.filter(e => e.data < oggi);
  const prossime = unpaid.filter(e => e.data >= oggi && e.data < fineISO);
  const oltre = unpaid.filter(e => e.data >= fineISO);

  const riga = e => `<tr>
    <td>${e.data}</td><td>${e.supplier_nome}</td><td>${e.descrizione || ''}</td>
    <td class="num">${eur2(e.importo)}</td></tr>`;
  const tot = list => list.reduce((s, e) => s + e.importo, 0);

  let html = '';
  if (scadute.length) {
    html += `<h6 class="prev-mese saldo-neg">⚠ Scadute / da saldare — ${eur2(tot(scadute))}</h6>
      <table class="prev-tbl"><tbody>${scadute.map(riga).join('')}</tbody></table>`;
  }
  const perMese = {};
  for (const e of prossime) (perMese[e.data.slice(0, 7)] ??= []).push(e);
  for (const [ym, list] of Object.entries(perMese)) {
    const [y, m] = ym.split('-');
    html += `<h6 class="prev-mese">${MESI[Number(m) - 1]} ${y} — ${eur2(tot(list))}</h6>
      <table class="prev-tbl"><tbody>${list.map(riga).join('')}</tbody></table>`;
  }
  if (oltre.length) {
    html += `<p class="muted small">Oltre l'orizzonte: ${oltre.length} spese per ${eur2(tot(oltre))}</p>`;
  }
  el('dash-previste').innerHTML = html || '<p class="muted">Nessuna spesa da pagare in programma 🎉</p>';
}

/* ---- spese ---- */

const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

const MESI_BREVI = ['gen', 'feb', 'mar', 'apr', 'mag', 'giu', 'lug', 'ago', 'set', 'ott', 'nov', 'dic'];
const fmtData = iso => iso ? `${Number(iso.slice(8, 10))} ${MESI_BREVI[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}` : '';

function renderSpese() {
  // opzioni form (preserva la selezione per l'inserimento seriale)
  const keepVal = (id, html) => { const s = el(id); const v = s.value; s.innerHTML = html; if (v) s.value = v; };
  keepVal('sp-fornitore', '<option value="" disabled selected>Fornitore…</option>' +
    state.suppliers.map(s => `<option value="${s.id}">${s.nome}</option>`).join(''));
  keepVal('sp-split', `<option value="50_50">50 / 50</option>` +
    state.persons.map(p => `<option value="${p.id}">solo ${p.nome}</option>`).join(''));
  if (!el('sp-data').value) el('sp-data').value = new Date().toISOString().slice(0, 10);

  const cats = [...new Set(state.expenses.map(e => e.categoria).filter(Boolean))].sort();
  el('categorie-note').innerHTML = cats.map(c => `<option value="${c}">`).join('');

  // filtri
  const keep = (sel, opts, fmt) => {
    const cur = sel.value;
    sel.innerHTML = sel.options[0].outerHTML + opts.map(fmt).join('');
    sel.value = cur;
  };
  keep(el('flt-fornitore'), state.suppliers, s => `<option value="${s.id}">${s.nome}</option>`);
  keep(el('flt-categoria'), cats, c => `<option value="${c}">${c}</option>`);

  const ff = el('flt-fornitore').value, fc = el('flt-categoria').value, fs = el('flt-stato').value;
  const ft = el('flt-testo').value.trim().toLowerCase();
  let rows = state.expenses;
  if (ff) rows = rows.filter(e => e.supplier_id === Number(ff));
  if (fc) rows = rows.filter(e => e.categoria === fc);
  if (fs !== '') rows = rows.filter(e => e.pagata === (fs === '1'));
  if (ft) rows = rows.filter(e =>
    [e.descrizione, e.categoria, e.supplier_nome, e.data, String(e.importo)]
      .some(v => String(v || '').toLowerCase().includes(ft)));

  const { key, dir } = state.sortSpese;
  rows = [...rows].sort((a, b) => {
    const va = a[key], vb = b[key];
    const cmp = (typeof va === 'number' || typeof va === 'boolean')
      ? Number(va) - Number(vb)
      : String(va ?? '').localeCompare(String(vb ?? ''), 'it');
    return cmp * dir;
  });
  el('tbl-spese').querySelectorAll('thead th').forEach(th => {
    th.classList.toggle('sort-asc', th.dataset.key === key && dir === 1);
    th.classList.toggle('sort-desc', th.dataset.key === key && dir === -1);
  });

  const fornOpts = sel => state.suppliers.map(s =>
    `<option value="${s.id}" ${s.id === sel ? 'selected' : ''}>${s.nome}</option>`).join('');
  const splitOpts = sel => `<option value="50_50" ${sel === '50_50' ? 'selected' : ''}>50/50</option>` +
    state.persons.map(p => `<option value="${p.id}" ${String(p.id) === String(sel) ? 'selected' : ''}>solo ${p.nome}</option>`).join('');

  const oggi = new Date().toISOString().slice(0, 10);
  el('tbl-spese').querySelector('tbody').innerHTML = rows.map(e => `
    <tr class="${e.pagata ? '' : 'da-pagare'}${e.data > oggi ? ' futura' : ''}">
      <td data-l="Data" class="cell-data">
        <span class="data-txt" title="Click per modificare la data"
          onclick="const i = this.nextElementSibling; i.showPicker ? i.showPicker() : i.focus()">${fmtData(e.data)}</span>
        <input type="date" value="${e.data}" tabindex="-1" onchange="saveExpInline(${e.id},'data',this.value)">
      </td>
      <td data-l="Fornitore"><select onchange="saveExpInline(${e.id},'supplier_id',Number(this.value))">${fornOpts(e.supplier_id)}</select></td>
      <td data-l="Bonus"><select class="badge-sel ${e.bonus_type}" onchange="saveExpInline(${e.id},'bonus_override',this.value)" title="Bonus per questa spesa (default: quello del fornitore)">
        ${['ristrutturazione', 'ecobonus', 'mobili', 'nessuno'].map(b =>
          `<option value="${b}" ${e.bonus_type === b ? 'selected' : ''}>${b}</option>`).join('')}
      </select></td>
      <td data-l="Descrizione"><input type="text" value="${esc(e.descrizione)}" onchange="saveExpInline(${e.id},'descrizione',this.value)"></td>
      <td data-l="Categoria"><input type="text" value="${esc(e.categoria)}" list="categorie-note" onchange="saveExpInline(${e.id},'categoria',this.value)"></td>
      <td class="num" data-l="Importo €"><input type="number" step="0.01" min="0.01" value="${e.importo}" onchange="saveExpInline(${e.id},'importo',Number(this.value))"></td>
      <td data-l="Split"><select onchange="saveExpInline(${e.id},'split',this.value)">${splitOpts(e.split)}</select></td>
      <td class="cell-badges">
        <span class="badge clickable ${e.pagata ? 'pagata' : 'off'}" onclick="saveExpInline(${e.id},'pagata',${!e.pagata})" title="Click per cambiare stato">pagata</span></td>
      <td class="cell-badges">
        <span class="badge clickable ${e.detraibile ? 'detraibile' : 'off'}" onclick="saveExpInline(${e.id},'detraibile',${!e.detraibile})" title="Bonifico parlante: click per cambiare">detraibile</span></td>
      <td class="cell-actions">
        <button class="icon-btn" onclick="duplicateExpense(${e.id})" title="Duplica">⧉</button>
        <button class="icon-btn" onclick="deleteExpense(${e.id})" title="Elimina">🗑️</button>
      </td>
    </tr>`).join('');

  const tot = rows.reduce((s, e) => s + e.importo, 0);
  const totPag = rows.filter(e => e.pagata).reduce((s, e) => s + e.importo, 0);
  el('spese-totali').textContent = `${rows.length} spese · totale ${eur2(tot)} · pagato ${eur2(totPag)} · da pagare ${eur2(tot - totPag)}`;

  // spese casa per categoria
  const byCat = {};
  for (const e of state.expenses) {
    const c = e.categoria || '(senza categoria)';
    byCat[c] = byCat[c] || { tot: 0, pagato: 0 };
    byCat[c].tot += e.importo;
    if (e.pagata) byCat[c].pagato += e.importo;
  }
  el('spese-per-categoria').innerHTML = '<table><thead><tr><th>Categoria</th><th class="num">Totale</th><th class="num">Pagato</th><th class="num">Da pagare</th></tr></thead><tbody>' +
    Object.entries(byCat).sort((a, b) => b[1].tot - a[1].tot)
      .map(([c, v]) => `<tr><td>${c}</td><td class="num">${eur2(v.tot)}</td><td class="num">${eur2(v.pagato)}</td><td class="num">${eur2(v.tot - v.pagato)}</td></tr>`).join('') +
    '</tbody></table>';
}

window.saveExpInline = async (id, campo, valore) => {
  const e = state.expenses.find(x => x.id === id);
  if (campo === 'bonus_override') {
    // se coincide col bonus del fornitore non serve override
    const sup = state.suppliers.find(s => s.id === e.supplier_id);
    if (sup && valore === sup.bonus_type) valore = null;
  }
  await api('PUT', `/api/expenses/${id}`, { ...e, [campo]: valore });
  await refresh({ global: true });
};

window.duplicateExpense = async id => {
  const e = state.expenses.find(x => x.id === id);
  const { id: _, ...copia } = e;
  await api('POST', '/api/expenses', copia);
  await refresh({ global: true });
};

window.deleteExpense = async id => {
  if (!confirm('Eliminare questa spesa?')) return;
  await api('DELETE', `/api/expenses/${id}`);
  await refresh({ global: true });
};

/* ---- aggiunta multipla ---- */

function bulkRowHtml() {
  const oggi = new Date().toISOString().slice(0, 10);
  const forn = state.suppliers.map(s => `<option value="${s.id}">${s.nome}</option>`).join('');
  const split = `<option value="50_50">50 / 50</option>` +
    state.persons.map(p => `<option value="${p.id}">solo ${p.nome}</option>`).join('');
  return `<tr>
    <td><input type="date" class="bk-data" value="${oggi}"></td>
    <td><select class="bk-fornitore"><option value="" disabled selected>…</option>${forn}</select></td>
    <td><input type="number" class="bk-importo" step="0.01" min="0.01" placeholder="0,00"></td>
    <td><select class="bk-split">${split}</select></td>
    <td><input type="text" class="bk-descrizione"></td>
    <td><input type="text" class="bk-categoria" list="categorie-note"></td>
    <td><input type="checkbox" class="bk-pagata" checked></td>
    <td><input type="checkbox" class="bk-detraibile"></td>
    <td><button class="icon-btn bk-del" title="Rimuovi riga">🗑️</button></td>
  </tr>`;
}

function bulkAddRow() {
  el('tbl-bulk').querySelector('tbody').insertAdjacentHTML('beforeend', bulkRowHtml());
}

async function bulkSave() {
  const rows = [...el('tbl-bulk').querySelectorAll('tbody tr')];
  const spese = [];
  for (const tr of rows) {
    const get = c => tr.querySelector(c);
    const supplier = get('.bk-fornitore').value;
    const importo = get('.bk-importo').value;
    if (!supplier && !importo) continue; // riga vuota: ignorata
    if (!supplier || !importo || !get('.bk-data').value) {
      alert('Righe incomplete: servono data, fornitore e importo (o lascia la riga vuota).');
      return;
    }
    spese.push({
      supplier_id: Number(supplier),
      data: get('.bk-data').value,
      importo: Number(importo),
      split: get('.bk-split').value,
      descrizione: get('.bk-descrizione').value,
      categoria: get('.bk-categoria').value,
      pagata: get('.bk-pagata').checked,
      detraibile: get('.bk-detraibile').checked,
    });
  }
  if (!spese.length) return;
  await api('POST', '/api/expenses/bulk', spese);
  el('tbl-bulk').querySelector('tbody').innerHTML = '';
  el('bulk-card').hidden = true;
  await refresh({ global: true });
}

/* ---- fornitori ---- */

function renderFornitori() {
  el('fo-eco-cat').innerHTML = state.ecoCats.map(c => `<option value="${c.id}">${c.nome}</option>`).join('');
  el('fo-eco-cat').hidden = el('fo-bonus').value !== 'ecobonus';

  const tot = {}, pag = {};
  for (const e of state.expenses) {
    tot[e.supplier_id] = (tot[e.supplier_id] || 0) + e.importo;
    if (e.pagata) pag[e.supplier_id] = (pag[e.supplier_id] || 0) + e.importo;
  }
  el('tbl-fornitori').querySelector('tbody').innerHTML = state.suppliers.map(s => {
    const cat = state.ecoCats.find(c => c.id === s.eco_category_id);
    return `<tr>
      <td data-l="Nome">${s.nome}</td>
      <td class="cell-badges"><span class="badge ${s.bonus_type}">${s.bonus_type}</span></td>
      <td data-l="Categoria eco">${cat ? cat.nome : ''}</td>
      <td class="num" data-l="Totale speso">${eur2(tot[s.id] || 0)}</td>
      <td class="num" data-l="di cui pagato">${eur2(pag[s.id] || 0)}</td>
      <td class="cell-actions">
        <button class="icon-btn" onclick="editSupplier(${s.id})" title="Modifica">✏️</button>
        <button class="icon-btn" onclick="deleteSupplier(${s.id})" title="Elimina">🗑️</button>
      </td>
    </tr>`;
  }).join('');
}

window.editSupplier = id => {
  const s = state.suppliers.find(x => x.id === id);
  if (!s) return;
  state.editingSupplier = id;
  el('fo-nome').value = s.nome;
  el('fo-bonus').value = s.bonus_type;
  el('fo-eco-cat').hidden = s.bonus_type !== 'ecobonus';
  if (s.eco_category_id) el('fo-eco-cat').value = s.eco_category_id;
  el('form-fornitore').querySelector('button[type=submit]').textContent = 'Salva';
};

window.deleteSupplier = async id => {
  if (!confirm('Eliminare questo fornitore?')) return;
  await api('DELETE', `/api/suppliers/${id}`);
  await refresh({ global: true });
};

/* ---- 730 ---- */

function render730() {
  const r = activeReport();
  el('btn-caf').href = `/api/caf/${state.anno}.csv`;
  el('liq-730').innerHTML = Object.values(r.persone).map(p => {
    const sp = p.spese;
    return `<article class="liq-card">
      <h4>${p.nome} — 730/${state.anno + 1} (redditi ${state.anno})</h4>
      <table>
        <tr><td>Reddito complessivo</td><td class="num">${eur2(p.reddito)}</td></tr>
        <tr><td>IRPEF lorda</td><td class="num">${eur2(p.irpef_lorda)}</td></tr>
        <tr><td colspan="2"><strong>Spese detraibili sostenute nel ${state.anno}</strong></td></tr>
        <tr><td>· Ristrutturazione (quota)</td><td class="num">${eur2(sp.ristrutturazione.detraibile)}</td></tr>
        <tr><td>· Ecobonus (quota)</td><td class="num">${eur2(sp.ecobonus)}</td></tr>
        <tr><td>· Bonus mobili (quota)</td><td class="num">${eur2(sp.mobili.detraibile)}</td></tr>
        ${p.cap_16ter != null ? `
        <tr><td>Tetto art. 16-ter (rata annua di spesa)</td><td class="num">${eur2(p.cap_16ter)}</td></tr>
        <tr><td>· Rata di spesa soggetta al tetto${p.pregresse_16ter_spesa ? ` (di cui pregresse ${eur2(p.pregresse_16ter_spesa)})` : ''}</td><td class="num">${eur2(p.rata_spesa_16ter)}</td></tr>` : ''}
        <tr><td>Detrazione totale (10 anni)</td><td class="num">${eur2(p.detrazione_decennale)}</td></tr>
        ${p.detrazione_decennale - p.detrazione_decennale_effettiva > 0.005 ? `
        <tr><td>· di cui recuperabile (capienza IRPEF)</td><td class="num">${eur2(p.detrazione_decennale_effettiva)}</td></tr>` : ''}
        <tr><td><strong>Rata detrazione anno ${state.anno}</strong></td><td class="num"><strong>${eur2(p.rata_detrazione)}</strong></td></tr>
        <tr><td>Detrazioni da anni precedenti</td><td class="num">${eur2(p.detrazioni_pregresse)}</td></tr>
        <tr><td>Detrazioni effettivamente usate</td><td class="num">${eur2(p.detrazioni_usate)}</td></tr>
        ${p.detrazioni_perse > 0 ? `<tr><td>⚠️ Detrazioni perse (incapienza)</td><td class="num">${eur2(p.detrazioni_perse)}</td></tr>` : ''}
        <tr><td>IRPEF netta</td><td class="num">${eur2(p.irpef_netta)}</td></tr>
        <tr><td>Ritenute sostituto d'imposta</td><td class="num">${eur2(p.ritenute)}</td></tr>
        <tr class="tot"><td>${p.saldo_730 >= 0 ? 'Rimborso stimato' : 'Debito stimato'}</td>
          <td class="num"><span class="${p.saldo_730 >= 0 ? 'saldo-pos' : 'saldo-neg'}">${eur2(Math.abs(p.saldo_730))}</span></td></tr>
      </table>
      <div class="muted small">Spese non detraibili: ${eur2(sp.non_detraibili)} · aliquota applicata: ${pct(r.aliquota)}</div>
    </article>`;
  }).join('');
}

/* ---- configurazione ---- */

function renderConfig() {
  document.querySelectorAll('.cfg-anno').forEach(s => s.textContent = state.anno);

  el('cfg-persone').innerHTML = state.persons.map(p => {
    const py = state.personYears[p.id] || {};
    return `<article class="persona-card">
      <h5><input type="text" id="pn-${p.id}" value="${p.nome}" style="font-weight:700" onchange="savePerson(${p.id})"></h5>
      <label>Reddito imponibile IRPEF ${state.anno} (da CU, non la RAL)
        <input type="number" step="0.01" id="py-reddito-${p.id}" value="${py.reddito ?? ''}" placeholder="0" onchange="savePerson(${p.id})" title="Usare l'imponibile fiscale del CU (RAL meno contributi INPS a carico dipendente). Inserendo la RAL l'IRPEF lorda viene sovrastimata e il saldo 730 risulta falsamente a debito."></label>
      <label>Ritenute IRPEF (sostituto d'imposta)
        <input type="number" step="0.01" id="py-ritenute-${p.id}" value="${py.ritenute ?? ''}" placeholder="0" onchange="savePerson(${p.id})"></label>
    </article>`;
  }).join('');

  renderPregresse();

  const s = state.settings;
  el('form-settings').innerHTML = `
    <label>Abitazione principale
      <select id="st-abitazione"><option value="1" ${s.abitazione_principale ? 'selected' : ''}>sì</option><option value="0" ${!s.abitazione_principale ? 'selected' : ''}>no</option></select></label>
    <label>Aliquota prima casa %<input type="number" step="1" id="st-aliq1" value="${s.aliquota_prima_casa * 100}"></label>
    <label>Aliquota altre %<input type="number" step="1" id="st-aliq2" value="${s.aliquota_altre * 100}"></label>
    <label>Tetto ristrutturazione €<input type="number" step="1000" id="st-tetto-r" value="${s.tetto_ristrutturazione}"></label>
    <label>Tetto mobili €<input type="number" step="500" id="st-tetto-m" value="${s.tetto_mobili}"></label>
    <label>16-ter: soglia reddito €<input type="number" step="1000" id="st-16t-soglia" value="${s.cap16ter_soglia}"></label>
    <label>16-ter: base 75-100k €<input type="number" step="500" id="st-16t-b1" value="${s.cap16ter_base_fascia1}"></label>
    <label>16-ter: base >100k €<input type="number" step="500" id="st-16t-b2" value="${s.cap16ter_base_fascia2}"></label>
    <label>16-ter: coefficiente<input type="number" step="0.05" id="st-16t-coeff" value="${s.cap16ter_coefficiente}"></label>
    <label>Scaglioni IRPEF (limite:aliquota%, ; separati)
      <input type="text" id="st-scaglioni" value="${s.scaglioni.map(x => `${x[0] ?? ''}:${x[1] * 100}`).join('; ')}"></label>`;

  el('tbl-eco-cat').querySelector('tbody').innerHTML = state.ecoCats.map(c => `
    <tr>
      <td><input type="text" value="${c.nome}" onchange="saveEcoCat(${c.id}, this.value, null)"></td>
      <td class="num"><input type="number" step="500" value="${c.massimale_detrazione ?? ''}" onchange="saveEcoCat(${c.id}, null, this.value)"></td>
      <td><button class="icon-btn" onclick="deleteEcoCat(${c.id})">🗑️</button></td>
    </tr>`).join('');
}

window.savePerson = async pid => {
  await api('PUT', `/api/persons/${pid}`, { nome: el(`pn-${pid}`).value });
  await api('PUT', `/api/person-years/${state.anno}/${pid}`, {
    reddito: el(`py-reddito-${pid}`).value || 0,
    ritenute: el(`py-ritenute-${pid}`).value || 0,
  });
  await refresh({ global: true });
};

/* ---- rimborsi/rate anni precedenti ---- */

function renderPregresse() {
  const sel = el('pg-persona');
  const cur = sel.value; // selezione preservata per l'inserimento seriale
  sel.innerHTML = state.persons.map(p => `<option value="${p.id}">${p.nome}</option>`).join('');
  if (cur) sel.value = cur;
  if (!el('pg-anno').value) el('pg-anno').value = state.anno - 1;

  el('tbl-pregresse').querySelector('tbody').innerHTML = state.priorDeductions.map(d => {
    const persona = state.persons.find(p => p.id === d.person_id);
    const rata = d.importo_spesa * d.aliquota / d.rate_totali;
    const primo = d.anno_spesa, ultimo = d.anno_spesa + d.rate_totali - 1;
    const attiva = primo < state.anno && state.anno <= ultimo;
    const sedici = d.anno_spesa >= 2025;
    const persSel = state.persons.map(p =>
      `<option value="${p.id}" ${p.id === d.person_id ? 'selected' : ''}>${p.nome}</option>`).join('');
    return `<tr class="${attiva ? '' : 'muted'}">
      <td data-l="Persona"><select onchange="savePregressa(${d.id}, 'person_id', this.value)">${persSel}</select></td>
      <td data-l="Descrizione"><input type="text" value="${d.descrizione}" onchange="savePregressa(${d.id}, 'descrizione', this.value)"></td>
      <td class="num" data-l="Importo spesa €"><input type="number" step="0.01" value="${d.importo_spesa}" onchange="savePregressa(${d.id}, 'importo_spesa', this.value)"></td>
      <td class="num" data-l="Anno spesa"><input type="number" value="${d.anno_spesa}" onchange="savePregressa(${d.id}, 'anno_spesa', this.value)"></td>
      <td class="num" data-l="Totale rate"><input type="number" min="1" value="${d.rate_totali}" onchange="savePregressa(${d.id}, 'rate_totali', this.value)"></td>
      <td class="num" data-l="Aliquota %"><input type="number" step="1" value="${Math.round(d.aliquota * 100)}" onchange="savePregressa(${d.id}, 'aliquota', this.value / 100)"></td>
      <td class="num" data-l="Rata detrazione/anno">${eur2(rata)}</td>
      <td data-l="16-ter">${sedici ? '⚠️ sì' : 'no'}</td>
      <td class="cell-badges">${attiva ? `<span class="badge pagata">attiva (${primo + 1}–${ultimo})</span>` : `<span class="badge nessuno">non attiva nel ${state.anno}</span>`}</td>
      <td class="cell-actions"><button class="icon-btn" onclick="deletePregressa(${d.id})" title="Elimina">🗑️</button></td>
    </tr>`;
  }).join('');
}

window.savePregressa = async (id, campo, valore) => {
  const d = state.priorDeductions.find(x => x.id === id);
  const body = { ...d, [campo]: campo === 'descrizione' ? valore : Number(valore) };
  await api('PUT', `/api/prior-deductions/${id}`, body);
  await refresh({ global: true });
};

window.deletePregressa = async id => {
  if (!confirm('Eliminare questa voce?')) return;
  await api('DELETE', `/api/prior-deductions/${id}`);
  await refresh({ global: true });
};

/* ---- backup ---- */

const fmtSize = b => b > 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.round(b / 1024) + ' KB';

async function renderBackups() {
  const backups = await api('GET', '/api/backups');
  el('tbl-backups').querySelector('tbody').innerHTML = backups.map(b => `
    <tr>
      <td data-l="Data">${b.mtime.replace('T', ' ')}</td>
      <td class="cell-badges"><span class="badge ${b.tag === 'auto' ? 'nessuno' : b.tag === 'manuale' ? 'ristrutturazione' : 'mobili'}">${b.tag}</span></td>
      <td class="num" data-l="Dimensione">${fmtSize(b.size)}</td>
      <td class="cell-actions">
        <button class="icon-btn" onclick="restoreBackup('${b.name}')" title="Ripristina questo snapshot">♻️</button>
        <a class="icon-btn" href="/api/backups/${b.name}/download" title="Scarica">⬇️</a>
        <button class="icon-btn" onclick="deleteBackup('${b.name}')" title="Elimina">🗑️</button>
      </td>
    </tr>`).join('');
}

window.restoreBackup = async name => {
  if (!confirm(`Ripristinare lo snapshot ${name}?\nI dati attuali vengono prima salvati come snapshot "prerestore".`)) return;
  await api('POST', `/api/backups/${name}/restore`);
  await refresh({ global: true });
  await renderBackups();
};

window.deleteBackup = async name => {
  if (!confirm(`Eliminare lo snapshot ${name}?`)) return;
  await api('DELETE', `/api/backups/${name}`);
  await renderBackups();
};

window.saveEcoCat = async (id, nome, max) => {
  const c = state.ecoCats.find(x => x.id === id);
  await api('PUT', `/api/eco-categories/${id}`, {
    nome: nome ?? c.nome,
    massimale_detrazione: max !== null ? (max === '' ? null : Number(max)) : c.massimale_detrazione,
  });
  await refresh({ global: true });
};

window.deleteEcoCat = async id => {
  if (!confirm('Eliminare la categoria?')) return;
  await api('DELETE', `/api/eco-categories/${id}`);
  await refresh({ global: true });
};

/* ---------------- eventi ---------------- */

function bindEvents() {
  document.querySelectorAll('.tabs button').forEach(b =>
    b.addEventListener('click', () => setTab(b.dataset.tab)));

  el('sel-anno').addEventListener('change', async e => {
    state.anno = Number(e.target.value);
    await refresh();
  });
  el('chk-solo-pagate').addEventListener('change', e => {
    state.soloPagate = e.target.checked;
    renderAll();
  });

  el('form-spesa').addEventListener('submit', async e => {
    e.preventDefault();
    await api('POST', '/api/expenses', {
      supplier_id: Number(el('sp-fornitore').value),
      data: el('sp-data').value,
      importo: Number(el('sp-importo').value),
      split: el('sp-split').value,
      descrizione: el('sp-descrizione').value,
      categoria: el('sp-categoria').value,
      pagata: el('sp-pagata').checked,
      detraibile: el('sp-detraibile').checked,
    });
    // inserimento seriale: data/fornitore/split/categoria restano, importo e descrizione si svuotano
    el('sp-importo').value = '';
    el('sp-descrizione').value = '';
    await refresh({ global: true });
    el('sp-importo').focus();
  });

  el('bulk-open').addEventListener('click', () => {
    el('bulk-card').hidden = false;
    if (!el('tbl-bulk').querySelector('tbody tr')) for (let i = 0; i < 3; i++) bulkAddRow();
  });
  el('bulk-add-row').addEventListener('click', bulkAddRow);
  el('bulk-save').addEventListener('click', bulkSave);
  el('bulk-cancel').addEventListener('click', () => { el('bulk-card').hidden = true; });
  el('tbl-bulk').addEventListener('click', e => {
    if (e.target.classList.contains('bk-del')) e.target.closest('tr').remove();
  });

  ['flt-fornitore', 'flt-categoria', 'flt-stato'].forEach(id =>
    el(id).addEventListener('change', renderSpese));
  el('flt-testo').addEventListener('input', renderSpese);

  el('tbl-spese').querySelector('thead').addEventListener('click', e => {
    const key = e.target.closest('th')?.dataset.key;
    if (!key) return;
    const s = state.sortSpese;
    state.sortSpese = { key, dir: s.key === key ? -s.dir : 1 };
    renderSpese();
  });

  el('btn-theme').addEventListener('click', () => {
    applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
    renderAll(); // ricrea i grafici con i colori del tema
  });

  el('fo-bonus').addEventListener('change', e => {
    el('fo-eco-cat').hidden = e.target.value !== 'ecobonus';
  });
  el('form-fornitore').addEventListener('submit', async e => {
    e.preventDefault();
    const body = {
      nome: el('fo-nome').value,
      bonus_type: el('fo-bonus').value,
      eco_category_id: el('fo-bonus').value === 'ecobonus' ? Number(el('fo-eco-cat').value) || null : null,
    };
    if (state.editingSupplier) await api('PUT', `/api/suppliers/${state.editingSupplier}`, body);
    else await api('POST', '/api/suppliers', body);
    state.editingSupplier = null;
    el('form-fornitore').reset();
    el('form-fornitore').querySelector('button[type=submit]').textContent = 'Aggiungi';
    await refresh({ global: true });
  });

  el('form-settings').addEventListener('change', async () => {
    const scaglioni = el('st-scaglioni').value.split(';').map(s => {
      const [lim, aliq] = s.split(':');
      return [lim.trim() === '' ? null : Number(lim), Number(aliq) / 100];
    });
    await api('PUT', `/api/settings/${state.anno}`, {
      abitazione_principale: el('st-abitazione').value === '1',
      aliquota_prima_casa: Number(el('st-aliq1').value) / 100,
      aliquota_altre: Number(el('st-aliq2').value) / 100,
      tetto_ristrutturazione: Number(el('st-tetto-r').value),
      tetto_mobili: Number(el('st-tetto-m').value),
      cap16ter_soglia: Number(el('st-16t-soglia').value),
      cap16ter_base_fascia1: Number(el('st-16t-b1').value),
      cap16ter_base_fascia2: Number(el('st-16t-b2').value),
      cap16ter_coefficiente: Number(el('st-16t-coeff').value),
      scaglioni,
    });
    await refresh();
  });

  el('form-pregressa').addEventListener('submit', async e => {
    e.preventDefault();
    await api('POST', '/api/prior-deductions', {
      person_id: Number(el('pg-persona').value),
      descrizione: el('pg-descrizione').value,
      importo_spesa: Number(el('pg-importo').value),
      anno_spesa: Number(el('pg-anno').value),
      rate_totali: Number(el('pg-rate').value) || 10,
      aliquota: (Number(el('pg-aliquota').value) || 50) / 100,
    });
    // inserimento seriale come per le spese: persona/anno/rate/aliquota restano,
    // descrizione e importo si svuotano, focus sull'importo
    el('pg-descrizione').value = '';
    el('pg-importo').value = '';
    await refresh({ global: true });
    el('pg-importo').focus();
  });

  el('btn-snapshot').addEventListener('click', async () => {
    await api('POST', '/api/backups');
    await renderBackups();
  });

  el('form-eco-cat').addEventListener('submit', async e => {
    e.preventDefault();
    await api('POST', '/api/eco-categories', {
      nome: el('ec-nome').value,
      massimale_detrazione: el('ec-max').value ? Number(el('ec-max').value) : null,
    });
    el('form-eco-cat').reset();
    await refresh({ global: true });
  });

  el('btn-export').addEventListener('click', async () => {
    const data = await api('GET', '/api/export');
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `ristruttura730-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
  });
  el('btn-import').addEventListener('click', () => el('file-import').click());
  el('file-import').addEventListener('change', async e => {
    const file = e.target.files[0];
    if (!file) return;
    if (!confirm('Il ripristino SOSTITUISCE tutti i dati attuali. Continuare?')) return;
    const data = JSON.parse(await file.text());
    await api('POST', '/api/import', data);
    await refresh({ global: true });
  });
}

/* ---------------- avvio ---------------- */

function setTab(nome) {
  if (!document.getElementById(`tab-${nome}`)) nome = 'dashboard';
  document.querySelectorAll('.tabs button').forEach(x => x.classList.toggle('active', x.dataset.tab === nome));
  document.querySelectorAll('.tab').forEach(t => t.hidden = t.id !== `tab-${nome}`);
  history.replaceState(null, '', `#${nome}`); // il tab sopravvive al refresh
  if (nome === 'config') renderBackups();
}

(async function init() {
  bindEvents();
  applyTheme(localStorage.getItem('theme') || 'light');
  setTab(location.hash.slice(1) || 'dashboard');
  await refresh({ global: true });
})();
