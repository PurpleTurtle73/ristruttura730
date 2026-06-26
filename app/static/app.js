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
  tasks: [],          // attività del cronoprogramma (globali, non per anno)
  ganttDayWidth: 18,  // px per giorno nel Gantt
  ganttFrom: null,    // finestra date esplicita (null = auto sui task)
  ganttTo: null,
  ganttRangePreset: 'all',
  ganttTitolo: localStorage.getItem('ganttTitolo') || '',
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
  [state.years, state.persons, state.suppliers, state.ecoCats, state.priorDeductions, state.tasks] = await Promise.all([
    api('GET', '/api/years'),
    api('GET', '/api/persons'),
    api('GET', '/api/suppliers'),
    api('GET', '/api/eco-categories'),
    api('GET', '/api/prior-deductions'),
    api('GET', '/api/tasks'),
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
  renderLavori();
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
    <td>${fmtData(e.data)}</td><td>${e.supplier_nome}</td><td>${e.descrizione || ''}</td>
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
// formato italiano "31 dic 2025" (giorno, mese breve, anno) — usato ovunque
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

/* ---- lavori / cronoprogramma (Gantt) ---- */

// utility date UTC (niente sfasamenti per fuso/DST)
const isoToDate = iso => new Date(iso + 'T00:00:00Z');
const dateToIso = d => d.toISOString().slice(0, 10);
const addDays = (iso, n) => dateToIso(new Date(isoToDate(iso).getTime() + n * 86400000));
const dayDiff = (a, b) => Math.round((isoToDate(b).getTime() - isoToDate(a).getTime()) / 86400000);
const parsePreds = s => String(s || '').split(',').map(x => parseInt(x, 10)).filter(n => Number.isFinite(n));
// colore testo leggibile sulla barra: nero sui colori chiari, bianco sui colori scuri
function testoPerSfondo(hex) {
  let h = (hex || '').replace('#', '');
  if (h.length === 3) h = h.split('').map(c => c + c).join('');
  if (h.length !== 6) return { color: '#fff', scuro: false };
  const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return lum > 0.6 ? { color: '#000', scuro: true } : { color: '#fff', scuro: false };
}

// giorni lavorativi tra due date (estremi inclusi), esclusi sabato e domenica
function giorniLavorativi(inizio, fine) {
  let n = 0;
  for (let k = 0, tot = dayDiff(inizio, fine) + 1; k < tot; k++) {
    const g = isoToDate(addDays(inizio, k)).getUTCDay();
    if (g !== 0 && g !== 6) n++;
  }
  return n;
}

async function reloadTasks() {
  state.tasks = await api('GET', '/api/tasks');
  renderLavori();
}

window.saveTaskInline = async (id, field, value) => {
  await api('PUT', `/api/tasks/${id}`, { [field]: value });
  await reloadTasks();
};
window.saveTaskDate = async (id, isMilestone, value) => {
  // per un checkpoint inizio e fine coincidono
  const body = isMilestone ? { data_inizio: value, data_fine: value } : { data_inizio: value };
  await api('PUT', `/api/tasks/${id}`, body);
  await reloadTasks();
};
window.deleteTask = async id => {
  if (!confirm("Eliminare l'attività?")) return;
  await api('DELETE', `/api/tasks/${id}`);
  await reloadTasks();
};
window.addDep = async (id, predId) => {
  const t = state.tasks.find(x => x.id === id);
  const preds = [...parsePreds(t.predecessori), predId];
  await api('PUT', `/api/tasks/${id}`, { predecessori: preds.join(',') });
  await reloadTasks();
};
window.removeDep = async (id, predId) => {
  const t = state.tasks.find(x => x.id === id);
  const preds = parsePreds(t.predecessori).filter(p => p !== predId);
  await api('PUT', `/api/tasks/${id}`, { predecessori: preds.join(',') });
  await reloadTasks();
};
// riordino attività via trascinamento (pointer events: ok anche touch)
function bindTaskDrag(tbody) {
  let dr = null;
  tbody.addEventListener('pointerdown', e => {
    const grip = e.target.closest('.row-grip');
    if (!grip) return;
    const tr = grip.closest('tr');
    dr = { tr };
    tr.classList.add('dragging-row');
    tr.setPointerCapture?.(e.pointerId);
    e.preventDefault();
  });
  tbody.addEventListener('pointermove', e => {
    if (!dr) return;
    const rows = [...tbody.querySelectorAll('tr')];
    const after = rows.find(r => r !== dr.tr && e.clientY < r.getBoundingClientRect().top + r.offsetHeight / 2);
    if (after) tbody.insertBefore(dr.tr, after);
    else tbody.appendChild(dr.tr);
  });
  const end = async () => {
    if (!dr) return;
    const d = dr; dr = null;
    d.tr.classList.remove('dragging-row');
    const ids = [...tbody.querySelectorAll('tr')].map(r => Number(r.dataset.id));
    const attuale = state.tasks.map(t => t.id);
    if (ids.join() === attuale.join()) return;   // nessun cambiamento
    await api('POST', '/api/tasks/reorder', { ids });
    await reloadTasks();
  };
  tbody.addEventListener('pointerup', end);
  tbody.addEventListener('pointercancel', end);
}

/* --- aggiunta multipla attività --- */
function tkBulkRowHtml() {
  const oggi = new Date().toISOString().slice(0, 10);
  return `<tr>
    <td><input type="text" class="tb-nome" placeholder="Attività"></td>
    <td><input type="date" class="tb-inizio" value="${oggi}"></td>
    <td><input type="date" class="tb-fine" value="${oggi}"></td>
    <td><input type="color" class="tb-colore" value="#2563eb"></td>
    <td><button class="icon-btn tb-del" title="Rimuovi riga">🗑️</button></td>
  </tr>`;
}
function tkBulkAddRow() {
  el('tbl-tk-bulk').querySelector('tbody').insertAdjacentHTML('beforeend', tkBulkRowHtml());
}
async function tkBulkSave() {
  const rows = [...el('tbl-tk-bulk').querySelectorAll('tbody tr')];
  const tasks = [];
  for (const tr of rows) {
    const get = c => tr.querySelector(c);
    const nome = get('.tb-nome').value.trim();
    const inizio = get('.tb-inizio').value, fine = get('.tb-fine').value;
    if (!nome && !inizio && !fine) continue;       // riga vuota
    if (!nome || !inizio || !fine) { alert('Righe incomplete: servono nome, inizio e fine.'); return; }
    if (fine < inizio) { alert(`"${nome}": la fine precede l'inizio.`); return; }
    tasks.push({ nome, data_inizio: inizio, data_fine: fine, colore: get('.tb-colore').value });
  }
  if (!tasks.length) return;
  await api('POST', '/api/tasks/bulk', tasks);
  el('tbl-tk-bulk').querySelector('tbody').innerHTML = '';
  el('tk-bulk-card').hidden = true;
  await reloadTasks();
}

/* --- import CSV: nome,inizio,fine[,colore] --- */
function parseTasksCsv(text) {
  const righe = text.split(/\r?\n/).map(r => r.trim()).filter(Boolean);
  const out = [];
  const errori = [];
  righe.forEach((riga, idx) => {
    const c = riga.split(/[,;\t]/).map(x => x.trim().replace(/^"|"$/g, ''));
    // salta un'eventuale intestazione
    if (idx === 0 && /^(nome|name|attiv)/i.test(c[0]) && !/^\d{4}-\d{2}-\d{2}$/.test(c[1] || '')) return;
    const [nome, inizio, fine, colore] = c;
    if (!nome || !inizio || !fine) { errori.push(`riga ${idx + 1}: campi mancanti`); return; }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(inizio) || !/^\d{4}-\d{2}-\d{2}$/.test(fine)) {
      errori.push(`riga ${idx + 1}: date non valide (usa AAAA-MM-GG)`); return;
    }
    if (fine < inizio) { errori.push(`riga ${idx + 1}: la fine precede l'inizio`); return; }
    const t = { nome, data_inizio: inizio, data_fine: fine };
    if (colore && /^#?[0-9a-fA-F]{6}$/.test(colore)) t.colore = colore.startsWith('#') ? colore : '#' + colore;
    out.push(t);
  });
  return { out, errori };
}
async function importTasksCsv(file) {
  const text = await file.text();
  const { out, errori } = parseTasksCsv(text);
  if (errori.length) { alert('CSV non importato:\n' + errori.join('\n')); return; }
  if (!out.length) { alert('Nessuna riga valida nel CSV.'); return; }
  if (!confirm(`Importare ${out.length} attività dal CSV?`)) return;
  await api('POST', '/api/tasks/bulk', out);
  el('tk-csv-card').hidden = true;
  el('tk-csv-status').textContent = '';
  await reloadTasks();
}

function renderLavori() {
  const tasks = state.tasks;
  // default date odierne nel form
  const oggi = new Date().toISOString().slice(0, 10);
  if (!el('tk-inizio').value) el('tk-inizio').value = oggi;
  if (!el('tk-fine').value) el('tk-fine').value = oggi;

  const nomeById = id => { const t = tasks.find(x => x.id === id); return t ? t.nome : ('#' + id); };
  el('tbl-tasks').querySelector('tbody').innerHTML = tasks.map((t, idx) => {
    const preds = parsePreds(t.predecessori);
    const chips = preds.map(pid =>
      `<span class="dep-chip">${esc(nomeById(pid))}<button onclick="removeDep(${t.id},${pid})" title="Rimuovi">×</button></span>`).join('');
    const opts = tasks.filter(o => o.id !== t.id && !preds.includes(o.id))
      .map(o => `<option value="${o.id}">${esc(o.nome)}</option>`).join('');
    const ms = t.tipo === 'milestone';
    const dur = giorniLavorativi(t.data_inizio, t.data_fine);
    return `<tr data-id="${t.id}"${ms ? ' class="riga-ms"' : ''}>
      <td data-l="#" class="cell-ordine">
        <span class="row-grip" title="Trascina per riordinare">⠿</span>
        <span class="ord-num">${idx + 1}</span>
      </td>
      <td data-l="Attività"><input type="text" value="${esc(t.nome)}" onchange="saveTaskInline(${t.id},'nome',this.value)">${ms ? ' <span class="ms-badge" title="Checkpoint: giorno singolo">◆</span>' : ''}</td>
      <td data-l="${ms ? 'Giorno' : 'Inizio'}"><input type="date" value="${t.data_inizio}" onchange="saveTaskDate(${t.id}, ${ms}, this.value)"></td>
      <td data-l="Fine">${ms ? '<span class="muted">—</span>' : `<input type="date" value="${t.data_fine}" onchange="saveTaskInline(${t.id},'data_fine',this.value)">`}</td>
      <td data-l="Durata" class="num">${ms ? '<span class="muted">checkpoint</span>' : dur + ' gg'}</td>
      <td data-l="Dipende da"><div class="dep-cell">${chips}${opts
        ? `<select class="dep-add" onchange="if(this.value)addDep(${t.id},Number(this.value))"><option value="">+ dipendenza</option>${opts}</select>`
        : ''}</div></td>
      <td data-l="Colore"><input type="color" value="${t.colore}" onchange="saveTaskInline(${t.id},'colore',this.value)"></td>
      <td class="cell-actions"><button class="icon-btn" onclick="deleteTask(${t.id})" title="Elimina">🗑️</button></td>
    </tr>`;
  }).join('');

  renderGantt(tasks);
}

function renderGantt(tasks) {
  const g = el('gantt');
  if (!tasks.length) { g.innerHTML = '<p class="muted">Nessuna attività. Aggiungine una qui sopra.</p>'; return; }

  const ROW = 34, BAR = 22;
  // estensione automatica sui task (con un po' di margine)
  let autoStart = tasks[0].data_inizio, autoEnd = tasks[0].data_fine;
  for (const t of tasks) {
    if (t.data_inizio < autoStart) autoStart = t.data_inizio;
    if (t.data_fine > autoEnd) autoEnd = t.data_fine;
  }
  autoStart = addDays(autoStart, -2);
  autoEnd = addDays(autoEnd, 2);
  // finestra esplicita (relativa/esatta) se impostata, altrimenti auto
  let rangeStart = state.ganttFrom || autoStart;
  let rangeEnd = state.ganttTo || autoEnd;
  if (rangeEnd < rangeStart) rangeEnd = rangeStart;
  // sincronizza i controlli senza far ripartire eventi
  el('gantt-from').value = state.ganttFrom || '';
  el('gantt-to').value = state.ganttTo || '';
  document.querySelectorAll('.grng').forEach(b =>
    b.classList.toggle('active', b.dataset.range === (state.ganttRangePreset || 'all')));

  const totalDays = dayDiff(rangeStart, rangeEnd) + 1;
  // riempi tutta la larghezza disponibile: allarga i giorni se il piano è più stretto
  // della finestra (lo zoom manuale può comunque superare la larghezza -> scroll)
  let dw = state.ganttDayWidth;
  const avail = g.clientWidth;
  if (avail > 0) dw = Math.max(dw, avail / totalDays);
  const chartWidth = totalDays * dw;

  // header: banda mesi + giorni
  let monthCells = '', i = 0;
  while (i < totalDays) {
    const d = isoToDate(addDays(rangeStart, i));
    const m = d.getUTCMonth(), y = d.getUTCFullYear();
    let span = 0;
    while (i + span < totalDays) {
      const dd = isoToDate(addDays(rangeStart, i + span));
      if (dd.getUTCMonth() !== m || dd.getUTCFullYear() !== y) break;
      span++;
    }
    monthCells += `<div class="gantt-month" style="width:${span * dw}px">${MESI_BREVI[m]} ${y}</div>`;
    i += span;
  }
  let dayCells = '', weekendCols = '';
  for (let k = 0; k < totalDays; k++) {
    const dd = isoToDate(addDays(rangeStart, k));
    const we = dd.getUTCDay() === 0 || dd.getUTCDay() === 6;
    dayCells += `<div class="gantt-day${we ? ' we' : ''}" style="width:${dw}px">${dd.getUTCDate()}</div>`;
    if (we) weekendCols += `<div class="gantt-we-col" style="left:${k * dw}px;width:${dw}px"></div>`;
  }

  // lane checkpoint in cima (una sola riga condivisa) + attività sotto
  const milestones = tasks.filter(t => t.tipo === 'milestone');
  const activities = tasks.filter(t => t.tipo !== 'milestone');
  const laneBase = milestones.length ? 1 : 0;
  const totalRows = activities.length + laneBase;

  let rowsHtml = '', msLines = '';
  if (laneBase) {
    let lane = '';
    const cy = (ROW - 16) / 2;
    milestones.forEach(t => {
      const cx = dayDiff(rangeStart, t.data_inizio) * dw + dw / 2;
      msLines += `<div class="gantt-ms-line" style="left:${cx}px;border-color:${t.colore}"></div>`;
      lane += `<div class="gantt-ms" data-id="${t.id}" title="${esc(t.nome)} — checkpoint ${fmtData(t.data_inizio)}" style="left:${cx}px;top:${cy}px">
        <span class="ms-diamond" style="background:${t.colore}"></span>
        <span class="ms-name">${esc(t.nome)}</span>
      </div>`;
    });
    rowsHtml += `<div class="gantt-row gantt-lane" style="height:${ROW}px">${lane}</div>`;
  }
  activities.forEach((t, ai) => {
    const idx = laneBase + ai;
    const left = dayDiff(rangeStart, t.data_inizio) * dw;
    const width = (dayDiff(t.data_inizio, t.data_fine) + 1) * dw;
    const txt = testoPerSfondo(t.colore);
    rowsHtml += `<div class="gantt-row${idx % 2 ? ' alt' : ''}" style="height:${ROW}px">
      <div class="gantt-bar${txt.scuro ? ' testo-scuro' : ''}" data-id="${t.id}" title="${esc(t.nome)}: ${fmtData(t.data_inizio)} → ${fmtData(t.data_fine)}"
        style="left:${left}px;width:${width}px;top:${(ROW - BAR) / 2}px;height:${BAR}px;background:${t.colore};color:${txt.color}">
        <span class="grip" data-grip="start"></span>
        <span class="bar-label">${esc(t.nome)}</span>
        <span class="grip" data-grip="end"></span>
      </div>
    </div>`;
  });

  // frecce dipendenze (finish-to-start) — i checkpoint stanno tutti sulla lane 0
  const rowIndexOf = id => {
    const t = tasks.find(x => x.id === id);
    if (!t) return -1;
    if (t.tipo === 'milestone') return 0;
    return laneBase + activities.findIndex(x => x.id === id);
  };
  let paths = '';
  tasks.forEach(t => {
    const ti = rowIndexOf(t.id);
    parsePreds(t.predecessori).forEach(pid => {
      const pi = rowIndexOf(pid);
      if (pi < 0) return;
      const pred = tasks.find(x => x.id === pid);
      const x1 = (dayDiff(rangeStart, pred.data_fine) + 1) * dw;
      const y1 = pi * ROW + ROW / 2;
      const x2 = t.tipo === 'milestone'
        ? dayDiff(rangeStart, t.data_inizio) * dw + dw / 2
        : dayDiff(rangeStart, t.data_inizio) * dw;
      const y2 = ti * ROW + ROW / 2;
      const violato = dayDiff(pred.data_fine, t.data_inizio) <= 0;
      const midx = Math.max(x1 + 8, x2 - 8);
      paths += `<path d="M${x1},${y1} H${midx} V${y2} H${x2}" class="dep${violato ? ' violato' : ''}" marker-end="url(#gantt-arrow)"/>`;
    });
  });
  const svg = `<svg class="gantt-deps" width="${chartWidth}" height="${totalRows * ROW}">
    <defs><marker id="gantt-arrow" markerWidth="8" markerHeight="8" refX="6" refY="3.5" orient="auto">
      <path d="M0,0 L7,3.5 L0,7 z" class="dep-arrow"/></marker></defs>${paths}</svg>`;

  // linea "oggi"
  let todayLine = '';
  const td = dayDiff(rangeStart, oggiIso());
  if (td >= 0 && td < totalDays) todayLine = `<div class="gantt-today" style="left:${td * dw + dw / 2}px"></div>`;

  g.innerHTML = `<div class="gantt-scroll"><div class="gantt-inner" style="width:${chartWidth}px">
    <div class="gantt-header">
      <div class="gantt-months">${monthCells}</div>
      <div class="gantt-days">${dayCells}</div>
    </div>
    <div class="gantt-rows" style="height:${totalRows * ROW}px;background-size:${dw}px 100%">
      ${weekendCols}${svg}${msLines}${rowsHtml}${todayLine}
      <div class="gantt-hover" hidden><span class="gantt-hover-lbl"></span></div>
    </div>
  </div></div>`;

  const rows = g.querySelector('.gantt-rows');
  bindGanttDrag(rows, dw);
  bindGanttHover(rows, rangeStart, totalDays, dw);
}

// indicatore della giornata sotto il puntatore (banda + etichetta data)
function bindGanttHover(rows, rangeStart, totalDays, dw) {
  const hov = rows.querySelector('.gantt-hover');
  const lbl = hov.querySelector('.gantt-hover-lbl');
  rows.addEventListener('pointermove', e => {
    const rect = rows.getBoundingClientRect();
    let di = Math.floor((e.clientX - rect.left) / dw);
    if (di < 0) di = 0; else if (di >= totalDays) di = totalDays - 1;
    hov.hidden = false;
    hov.style.left = (di * dw) + 'px';
    hov.style.width = dw + 'px';
    lbl.textContent = fmtData(addDays(rangeStart, di));
  });
  rows.addEventListener('pointerleave', () => { hov.hidden = true; });
}

function oggiIso() { return new Date().toISOString().slice(0, 10); }

/* --- export Gantt in PDF (vettoriale, sempre tema chiaro) --- */

function downloadBlob(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/* --- export immagine PNG (rispecchia la vista a schermo, tema incluso) --- */
const xmlEsc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// palette coerente col tema attivo (come la vista web)
function ganttPalette(forceLight) {
  const dark = !forceLight && document.documentElement.dataset.theme === 'dark';
  return dark
    ? { bg: '#0f141b', head: '#161b22', headLine: '#262d37', weekend: 'rgba(248,113,113,.10)', grid: '#20262f', alt: 'rgba(96,165,250,.06)', month: '#9aa4b2', day: '#6b7585', dep: '#64748b', depViol: '#f87171', today: '#f87171', title: '#e6e9ee', outside: '#cdd3da', diaStroke: '#0f141b' }
    : { bg: '#ffffff', head: '#f1f4f9', headLine: '#dfe3e9', weekend: 'rgba(220,38,38,.07)', grid: '#e6e9ee', alt: 'rgba(37,99,235,.045)', month: '#555555', day: '#999999', dep: '#94a3b8', depViol: '#dc2626', today: '#dc2626', title: '#222222', outside: '#333333', diaStroke: '#ffffff' };
}

// SVG autonomo che rispecchia il Gantt a schermo (intero piano)
function buildGanttSvg() {
  const tasks = state.tasks;
  if (!tasks.length) return null;
  const dw = Math.max(20, state.ganttDayWidth);
  const ROW = 34, BAR = 22, HEAD = 34;
  const P = ganttPalette(true);   // export immagine sempre tema chiaro
  let s = tasks[0].data_inizio, e = tasks[0].data_fine;
  for (const t of tasks) { if (t.data_inizio < s) s = t.data_inizio; if (t.data_fine > e) e = t.data_fine; }
  s = addDays(s, -2); e = addDays(e, 2);
  // lane checkpoint in cima (una riga condivisa) + attività sotto
  const milestones = tasks.filter(t => t.tipo === 'milestone');
  const activities = tasks.filter(t => t.tipo !== 'milestone');
  const laneBase = milestones.length ? 1 : 0;
  const totalRows = activities.length + laneBase;
  const rowIndexOf = id => {
    const t = tasks.find(x => x.id === id);
    if (!t) return -1;
    if (t.tipo === 'milestone') return 0;
    return laneBase + activities.findIndex(x => x.id === id);
  };
  const N = dayDiff(s, e) + 1, dayW = N * dw, H = HEAD + totalRows * ROW;
  const CW = 6.4;

  const titolo = ('Piano lavori ' + (state.ganttTitolo || '')).trim();
  const hasTitle = !!(state.ganttTitolo || '').trim();
  const titleBand = hasTitle ? 30 : 0;

  const dur = t => (dayDiff(t.data_inizio, t.data_fine) + 1) * dw;
  let needW = dayW;
  tasks.forEach(t => {
    const left = dayDiff(s, t.data_inizio) * dw;
    if (t.tipo === 'milestone') needW = Math.max(needW, left + dw / 2 + 10 + (t.nome || '').length * CW + 6);
    else needW = Math.max(needW, left + 5 + (t.nome || '').length * CW + 6);
  });
  const W = Math.max(dayW, needW);

  const parts = [];
  parts.push(`<rect x="0" y="0" width="${W}" height="${H}" fill="${P.bg}"/>`);
  // colonne weekend (rosse, come a schermo)
  for (let k = 0; k < N; k++) {
    const g = isoToDate(addDays(s, k)).getUTCDay();
    if (g === 0 || g === 6) parts.push(`<rect x="${k * dw}" y="${HEAD}" width="${dw}" height="${H - HEAD}" fill="${P.weekend}"/>`);
  }
  for (let idx = 0; idx < totalRows; idx++) { if (idx % 2) parts.push(`<rect x="0" y="${HEAD + idx * ROW}" width="${W}" height="${ROW}" fill="${P.alt}"/>`); }
  parts.push(`<rect x="0" y="0" width="${W}" height="${HEAD}" fill="${P.head}"/>`);
  parts.push(`<line x1="0" y1="${HEAD}" x2="${W}" y2="${HEAD}" stroke="${P.headLine}" stroke-width="1"/>`);
  let i = 0;
  while (i < N) {
    const d = isoToDate(addDays(s, i)), m = d.getUTCMonth(), y = d.getUTCFullYear();
    let span = 0;
    while (i + span < N) { const dd = isoToDate(addDays(s, i + span)); if (dd.getUTCMonth() !== m || dd.getUTCFullYear() !== y) break; span++; }
    parts.push(`<text x="${i * dw + 4}" y="13" font-size="11" font-weight="700" fill="${P.month}">${MESI_BREVI[m]} ${y}</text>`);
    i += span;
  }
  if (dw >= 16) for (let k = 0; k < N; k++) {
    parts.push(`<text x="${k * dw + dw / 2}" y="29" font-size="9" fill="${P.day}" text-anchor="middle">${isoToDate(addDays(s, k)).getUTCDate()}</text>`);
  }
  tasks.forEach(t => {
    const ti = rowIndexOf(t.id);
    parsePreds(t.predecessori).forEach(pid => {
      const pi = rowIndexOf(pid); if (pi < 0) return;
      const pred = tasks.find(x => x.id === pid);
      const x1 = (dayDiff(s, pred.data_fine) + 1) * dw, y1 = HEAD + pi * ROW + ROW / 2;
      const x2 = t.tipo === 'milestone' ? dayDiff(s, t.data_inizio) * dw + dw / 2 : dayDiff(s, t.data_inizio) * dw;
      const y2 = HEAD + ti * ROW + ROW / 2;
      const viol = dayDiff(pred.data_fine, t.data_inizio) <= 0;
      const midx = Math.max(x1 + 8, x2 - 8);
      const col = viol ? P.depViol : P.dep;
      const dash = viol ? ' stroke-dasharray="4 3"' : '';
      parts.push(`<path d="M${x1},${y1} H${midx} V${y2} H${x2}" fill="none" stroke="${col}" stroke-width="${viol ? 2 : 1.5}"${dash}/>`);
      parts.push(`<path d="M${x2 - 6},${y2 - 3.5} L${x2},${y2} L${x2 - 6},${y2 + 3.5} z" fill="${col}"/>`);
    });
  });
  // attività
  activities.forEach((t, ai) => {
    const idx = laneBase + ai;
    const left = dayDiff(s, t.data_inizio) * dw, width = dur(t), top = HEAD + idx * ROW + (ROW - BAR) / 2;
    const nome = t.nome || '';
    parts.push(`<rect x="${left}" y="${top}" width="${width}" height="${BAR}" rx="5" fill="${t.colore}"/>`);
    if (nome) {
      const dentro = nome.length * CW + 10 <= width;
      parts.push(`<text x="${left + 5}" y="${top + BAR / 2 + 4}" font-size="11" font-weight="600" fill="${dentro ? testoPerSfondo(t.colore).color : P.outside}">${xmlEsc(nome)}</text>`);
    }
  });
  // checkpoint sulla lane 0 (linea tratteggiata a tutta altezza, diamante + nome)
  milestones.forEach(t => {
    const cx = dayDiff(s, t.data_inizio) * dw + dw / 2, cy = HEAD + ROW / 2, r = 7;
    parts.push(`<line x1="${cx}" y1="${HEAD}" x2="${cx}" y2="${H}" stroke="${t.colore}" stroke-width="1" stroke-dasharray="3 3" opacity="0.5"/>`);
    parts.push(`<path d="M${cx},${cy - r} L${cx + r},${cy} L${cx},${cy + r} L${cx - r},${cy} z" fill="${t.colore}" stroke="${P.diaStroke}" stroke-width="1"/>`);
    parts.push(`<text x="${cx + r + 3}" y="${cy + 4}" font-size="11" font-weight="600" fill="${P.outside}">${xmlEsc(t.nome || '')}</text>`);
  });
  const td = dayDiff(s, oggiIso());
  if (td >= 0 && td < N) parts.push(`<line x1="${td * dw + dw / 2}" y1="0" x2="${td * dw + dw / 2}" y2="${H}" stroke="${P.today}" stroke-width="2" opacity="0.6"/>`);

  const totalH = H + titleBand;
  const titleSvg = hasTitle ? `<text x="6" y="20" font-size="16" font-weight="700" fill="${P.title}">${xmlEsc(titolo)}</text>` : '';
  const str = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${totalH}" viewBox="0 0 ${W} ${totalH}" font-family="system-ui,Segoe UI,Roboto,sans-serif">` +
    `<rect x="0" y="0" width="${W}" height="${totalH}" fill="${P.bg}"/>${titleSvg}<g transform="translate(0,${titleBand})">${parts.join('')}</g></svg>`;
  return { str, w: W, h: totalH };
}

function svgToCanvas(svgStr, w, h, scale) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(new Blob([svgStr], { type: 'image/svg+xml;charset=utf-8' }));
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = Math.round(w * scale); c.height = Math.round(h * scale);
      const ctx = c.getContext('2d');
      ctx.scale(scale, scale);
      ctx.drawImage(img, 0, 0);
      URL.revokeObjectURL(url);
      resolve(c);
    };
    img.onerror = err => { URL.revokeObjectURL(url); reject(err); };
    img.src = url;
  });
}

async function exportGanttImg() {
  const svg = buildGanttSvg();
  if (!svg) { alert('Nessuna attività da esportare.'); return; }
  try {
    // alta risoluzione: 4× (limitata per non sforare i limiti del canvas)
    const scale = Math.max(1, Math.min(4, Math.floor(16000 / Math.max(svg.w, svg.h)) || 1));
    const canvas = await svgToCanvas(svg.str, svg.w, svg.h, scale);
    canvas.toBlob(b => downloadBlob(b, `gantt-${new Date().toISOString().slice(0, 10)}.png`), 'image/png');
  } catch (err) {
    alert('Export non riuscito: ' + (err.message || err));
  }
}

// PDF VETTORIALE A4 orizzontale: il Gantt è disegnato con primitive (no immagine)
function pdfCol(hex) {
  let h = (hex || '').replace('#', '');
  if (h.length === 3) h = h.split('').map(c => c + c).join('');
  if (h.length !== 6) return '0 0 0';
  const r = parseInt(h.slice(0, 2), 16) / 255, g = parseInt(h.slice(2, 4), 16) / 255, b = parseInt(h.slice(4, 6), 16) / 255;
  return `${r.toFixed(3)} ${g.toFixed(3)} ${b.toFixed(3)}`;
}
function pdfStr(s) {
  let out = '';
  for (const ch of String(s)) {
    const c = ch.codePointAt(0);
    if (ch === '(' || ch === ')' || ch === '\\') out += '\\' + ch;
    else if (c < 32) out += ' ';
    else if (c < 127) out += ch;
    else if (c < 256) out += '\\' + c.toString(8).padStart(3, '0');
    else out += '?';
  }
  return out;
}

function buildGanttPdf() {
  const tasks = state.tasks;
  if (!tasks.length) return null;
  const dw = Math.max(20, state.ganttDayWidth);
  const ROW = 30, BAR = 20, HEAD = 34;
  let s = tasks[0].data_inizio, e = tasks[0].data_fine;
  for (const t of tasks) { if (t.data_inizio < s) s = t.data_inizio; if (t.data_fine > e) e = t.data_fine; }
  s = addDays(s, -2); e = addDays(e, 2);
  // lane checkpoint in cima (una riga condivisa) + attività sotto
  const milestones = tasks.filter(t => t.tipo === 'milestone');
  const activities = tasks.filter(t => t.tipo !== 'milestone');
  const laneBase = milestones.length ? 1 : 0;
  const totalRows = activities.length + laneBase;
  const rowIndexOf = id => {
    const t = tasks.find(x => x.id === id);
    if (!t) return -1;
    if (t.tipo === 'milestone') return 0;
    return laneBase + activities.findIndex(x => x.id === id);
  };
  const N = dayDiff(s, e) + 1, dayW = N * dw, H = HEAD + totalRows * ROW;
  const CW = 6.2; // larghezza media carattere a 10px
  // PDF sempre in tema chiaro, indipendente dal tema della pagina
  const P = { bg: '#ffffff', head: '#f1f4f9', headLine: '#dfe3e9', weekend: '#fdeaea', grid: '#e6e9ee', alt: '#f2f5fd', month: '#555555', day: '#999999', dep: '#94a3b8', depViol: '#dc2626', today: '#dc2626', title: '#222222', outside: '#333333' };

  // barre a durata reale: il nome parte dentro e sfora a destra se la barra è corta
  const dur = t => (dayDiff(t.data_inizio, t.data_fine) + 1) * dw;
  let needW = dayW;
  tasks.forEach(t => {
    const left = dayDiff(s, t.data_inizio) * dw;
    if (t.tipo === 'milestone') needW = Math.max(needW, left + dw / 2 + 10 + (t.nome || '').length * CW + 6);
    else needW = Math.max(needW, left + 5 + (t.nome || '').length * CW + 6);
  });
  const W = Math.max(dayW, needW);

  // intestazione opzionale: "Piano lavori <input>"
  const titolo = ('Piano lavori ' + (state.ganttTitolo || '')).trim();
  const hasTitle = !!(state.ganttTitolo || '').trim();
  const titleBand = hasTitle ? 30 : 0;

  // A4 orizzontale, fit-to-page con margini (sotto l'eventuale titolo)
  const pageW = 842, pageH = 595, margin = 22;
  const topOff = margin + titleBand;
  const availW = pageW - 2 * margin, availH = pageH - topOff - margin;
  const S = Math.min(availW / W, availH / H);
  const MX = (pageW - W * S) / 2, MY = topOff + (availH - H * S) / 2;
  const X = x => (MX + x * S).toFixed(2);
  const Y = y => (pageH - MY - y * S).toFixed(2); // origine PDF in basso a sinistra
  const SZ = px => (px * S).toFixed(2);

  const ops = [];
  // sfondo pagina coerente col tema
  ops.push(`${pdfCol(P.bg)} rg 0 0 ${pageW} ${pageH} re f`);
  if (hasTitle) ops.push(`BT /F2 16 Tf ${pdfCol(P.title)} rg ${margin.toFixed(2)} ${(pageH - margin - 12).toFixed(2)} Td (${pdfStr(titolo)}) Tj ET`);
  const rect = (x, y, w, h, hex) => ops.push(`${pdfCol(hex)} rg ${X(x)} ${Y(y + h)} ${SZ(w)} ${SZ(h)} re f`);
  const line = (x1, y1, x2, y2, hex, wpt, dash) => ops.push(
    `${dash ? '[' + dash + '] 0 d ' : '[] 0 d '}${pdfCol(hex)} RG ${(wpt).toFixed(2)} w ${X(x1)} ${Y(y1)} m ${X(x2)} ${Y(y2)} l S`);
  const poly = (pts, hex) => ops.push(`${pdfCol(hex)} rg ${pts.map((p, i) => `${X(p[0])} ${Y(p[1])} ${i ? 'l' : 'm'}`).join(' ')} h f`);
  const text = (x, y, str, px, hex) => ops.push(`BT /F1 ${SZ(px)} Tf ${pdfCol(hex)} rg ${X(x)} ${Y(y)} Td (${pdfStr(str)}) Tj ET`);

  // weekend
  for (let k = 0; k < N; k++) { const g = isoToDate(addDays(s, k)).getUTCDay(); if (g === 0 || g === 6) rect(k * dw, HEAD, dw, H - HEAD, P.weekend); }
  // gridlines giorni
  for (let k = 0; k <= N; k++) line(k * dw, HEAD, k * dw, H, P.grid, 0.5);
  // righe alternate
  for (let idx = 0; idx < totalRows; idx++) { if (idx % 2) rect(0, HEAD + idx * ROW, W, ROW, P.alt); }
  // linee verticali dei checkpoint (sotto l'header)
  milestones.forEach(t => { const cx = dayDiff(s, t.data_inizio) * dw + dw / 2; line(cx, HEAD, cx, H, t.colore, 0.6, '3 3'); });
  // header
  rect(0, 0, W, HEAD, P.head);
  line(0, HEAD, W, HEAD, P.headLine, 0.6);
  let i = 0;
  while (i < N) {
    const d = isoToDate(addDays(s, i)), m = d.getUTCMonth(), y = d.getUTCFullYear();
    let span = 0;
    while (i + span < N) { const dd = isoToDate(addDays(s, i + span)); if (dd.getUTCMonth() !== m || dd.getUTCFullYear() !== y) break; span++; }
    text(i * dw + 3, 12, `${MESI_BREVI[m]} ${y}`, 10, P.month);
    i += span;
  }
  if (dw * S >= 12) for (let k = 0; k < N; k++) text(k * dw + dw / 2 - 3, 28, String(isoToDate(addDays(s, k)).getUTCDate()), 8, P.day);
  // dipendenze (i checkpoint stanno tutti sulla lane 0)
  tasks.forEach(t => {
    const ti = rowIndexOf(t.id);
    parsePreds(t.predecessori).forEach(pid => {
      const pi = rowIndexOf(pid); if (pi < 0) return;
      const pred = tasks.find(x => x.id === pid);
      const x1 = (dayDiff(s, pred.data_fine) + 1) * dw, y1 = HEAD + pi * ROW + ROW / 2;
      const x2 = t.tipo === 'milestone' ? dayDiff(s, t.data_inizio) * dw + dw / 2 : dayDiff(s, t.data_inizio) * dw;
      const y2 = HEAD + ti * ROW + ROW / 2;
      const viol = dayDiff(pred.data_fine, t.data_inizio) <= 0;
      const col = viol ? P.depViol : P.dep;
      const midx = Math.max(x1 + 8, x2 - 8);
      line(x1, y1, midx, y1, col, viol ? 1.2 : 0.9, viol ? '3 2' : null);
      line(midx, y1, midx, y2, col, viol ? 1.2 : 0.9, viol ? '3 2' : null);
      line(midx, y2, x2, y2, col, viol ? 1.2 : 0.9, viol ? '3 2' : null);
      poly([[x2 - 6, y2 - 3.5], [x2, y2], [x2 - 6, y2 + 3.5]], col);
    });
  });
  // barre/etichette attività
  activities.forEach((t, ai) => {
    const idx = laneBase + ai;
    const left = dayDiff(s, t.data_inizio) * dw;
    const width = dur(t);
    const top = HEAD + idx * ROW + (ROW - BAR) / 2;
    const nome = t.nome || '';
    rect(left, top, width, BAR, t.colore);
    if (nome) {
      const dentro = nome.length * CW + 8 <= width;
      text(left + 4, top + BAR / 2 + 3.5, nome, 10, dentro ? testoPerSfondo(t.colore).color : P.outside);
    }
  });
  // checkpoint sulla lane 0
  milestones.forEach(t => {
    const cx = dayDiff(s, t.data_inizio) * dw + dw / 2, cy = HEAD + ROW / 2, r = 7;
    poly([[cx, cy - r], [cx + r, cy], [cx, cy + r], [cx - r, cy]], t.colore);
    text(cx + r + 2, cy + 3.5, t.nome || '', 10, P.outside);
  });
  // linea oggi
  const td = dayDiff(s, oggiIso());
  if (td >= 0 && td < N) line(td * dw + dw / 2, 0, td * dw + dw / 2, H, P.today, 1.2);

  const content = 'q\n' + ops.join('\n') + '\nQ\n';
  const enc = str => { const a = new Uint8Array(str.length); for (let j = 0; j < str.length; j++) a[j] = str.charCodeAt(j) & 0xff; return a; };
  const chunks = []; let len = 0; const off = [];
  const add = str => { const u = enc(str); chunks.push(u); len += u.length; };
  const obj = (n, body) => { off[n] = len; add(`${n} 0 obj\n${body}\nendobj\n`); };
  add('%PDF-1.3\n');
  obj(1, '<</Type/Catalog/Pages 2 0 R>>');
  obj(2, '<</Type/Pages/Kids[3 0 R]/Count 1>>');
  obj(3, `<</Type/Page/Parent 2 0 R/MediaBox[0 0 ${pageW} ${pageH}]/Resources<</Font<</F1 4 0 R/F2 6 0 R>>>>/Contents 5 0 R>>`);
  obj(4, '<</Type/Font/Subtype/Type1/BaseFont/Helvetica/Encoding/WinAnsiEncoding>>');
  obj(5, `<</Length ${content.length}>>\nstream\n${content}endstream`);
  obj(6, '<</Type/Font/Subtype/Type1/BaseFont/Helvetica-Bold/Encoding/WinAnsiEncoding>>');
  const xrefPos = len;
  let xref = 'xref\n0 7\n0000000000 65535 f \n';
  for (let n = 1; n <= 6; n++) xref += String(off[n]).padStart(10, '0') + ' 00000 n \n';
  add(xref);
  add(`trailer\n<</Size 7/Root 1 0 R>>\nstartxref\n${xrefPos}\n%%EOF`);
  return new Blob(chunks, { type: 'application/pdf' });
}

// preset relativi della finestra del Gantt
function setGanttRange(preset) {
  state.ganttRangePreset = preset;
  const oggi = oggiIso();
  const y = Number(oggi.slice(0, 4)), m = Number(oggi.slice(5, 7));
  const ym = (yy, mm) => `${yy}-${String(mm).padStart(2, '0')}`;
  if (preset === 'all') {
    state.ganttFrom = state.ganttTo = null;
  } else if (preset === 'month') {
    state.ganttFrom = `${ym(y, m)}-01`;
    state.ganttTo = addDays(m === 12 ? `${y + 1}-01-01` : `${ym(y, m + 1)}-01`, -1);
  } else if (preset === 'quarter') {
    state.ganttFrom = oggi;
    const d = isoToDate(oggi); d.setUTCMonth(d.getUTCMonth() + 3);
    state.ganttTo = dateToIso(d);
  } else if (preset === 'year') {
    state.ganttFrom = `${y}-01-01`;
    state.ganttTo = `${y}-12-31`;
  }
  renderLavori();
}

function bindGanttDrag(container, dw) {
  let drag = null;
  container.addEventListener('pointerdown', e => {
    const elBar = e.target.closest('.gantt-bar, .gantt-ms');
    if (!elBar) return;
    const ms = elBar.classList.contains('gantt-ms');
    const grip = ms ? null : e.target.closest('[data-grip]');  // i checkpoint si spostano soltanto
    const t = state.tasks.find(x => x.id === Number(elBar.dataset.id));
    drag = {
      id: t.id, el: elBar, role: grip ? grip.dataset.grip : 'move', startX: e.clientX, delta: 0,
      inizio: t.data_inizio, fine: t.data_fine,
      left0: parseFloat(elBar.style.left), width0: parseFloat(elBar.style.width),
    };
    elBar.setPointerCapture?.(e.pointerId);
    elBar.classList.add('dragging');
    e.preventDefault();
  });
  container.addEventListener('pointermove', e => {
    if (!drag) return;
    const delta = Math.round((e.clientX - drag.startX) / dw);
    drag.delta = delta;
    if (drag.role === 'move') {
      drag.el.style.left = (drag.left0 + delta * dw) + 'px';
    } else if (drag.role === 'start') {
      const w = drag.width0 - delta * dw;
      if (w >= dw) { drag.el.style.left = (drag.left0 + delta * dw) + 'px'; drag.el.style.width = w + 'px'; }
    } else {
      const w = drag.width0 + delta * dw;
      if (w >= dw) drag.el.style.width = w + 'px';
    }
  });
  const finish = async () => {
    if (!drag) return;
    const d = drag; drag = null;
    d.el.classList.remove('dragging');
    if (!d.delta) { renderLavori(); return; }
    let body;
    if (d.role === 'move') {
      body = { data_inizio: addDays(d.inizio, d.delta), data_fine: addDays(d.fine, d.delta) };
    } else if (d.role === 'start') {
      let ni = addDays(d.inizio, d.delta);
      if (dayDiff(ni, d.fine) < 0) ni = d.fine;
      body = { data_inizio: ni };
    } else {
      let nf = addDays(d.fine, d.delta);
      if (dayDiff(d.inizio, nf) < 0) nf = d.inizio;
      body = { data_fine: nf };
    }
    await api('PUT', `/api/tasks/${d.id}`, body);
    await reloadTasks();
  };
  container.addEventListener('pointerup', finish);
  container.addEventListener('pointercancel', finish);
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

  // checkpoint: una sola data -> nascondi la data di fine
  el('tk-tipo').addEventListener('change', () => {
    el('tk-fine').style.display = el('tk-tipo').value === 'milestone' ? 'none' : '';
  });
  el('form-task').addEventListener('submit', async e => {
    e.preventDefault();
    const tipo = el('tk-tipo').value;
    const inizio = el('tk-inizio').value;
    const fine = tipo === 'milestone' ? inizio : el('tk-fine').value;
    if (fine < inizio) { alert('La data di fine precede quella di inizio'); return; }
    await api('POST', '/api/tasks', {
      nome: el('tk-nome').value, data_inizio: inizio, data_fine: fine, colore: el('tk-colore').value, tipo,
    });
    el('tk-nome').value = '';
    el('tk-nome').focus();
    await reloadTasks();
  });
  el('gantt-zoom-in').addEventListener('click', () => {
    state.ganttDayWidth = Math.min(60, state.ganttDayWidth + 6); renderLavori();
  });
  el('gantt-zoom-out').addEventListener('click', () => {
    state.ganttDayWidth = Math.max(6, state.ganttDayWidth - 6); renderLavori();
  });

  // aggiunta multipla attività
  el('tk-bulk-open').addEventListener('click', () => {
    el('tk-bulk-card').hidden = false;
    el('tk-csv-card').hidden = true;
    if (!el('tbl-tk-bulk').querySelector('tbody tr')) for (let i = 0; i < 3; i++) tkBulkAddRow();
  });
  el('tk-bulk-add-row').addEventListener('click', tkBulkAddRow);
  el('tk-bulk-save').addEventListener('click', tkBulkSave);
  el('tk-bulk-cancel').addEventListener('click', () => { el('tk-bulk-card').hidden = true; });
  el('tbl-tk-bulk').addEventListener('click', e => {
    if (e.target.closest('.tb-del')) { e.preventDefault(); e.target.closest('tr').remove(); }
  });

  // import CSV attività
  el('tk-csv-open').addEventListener('click', () => {
    el('tk-csv-card').hidden = false;
    el('tk-bulk-card').hidden = true;
  });
  el('tk-csv-pick').addEventListener('click', () => el('tk-csv-file').click());
  el('tk-csv-file').addEventListener('change', async e => {
    const file = e.target.files[0];
    if (!file) return;
    el('tk-csv-status').textContent = file.name;
    await importTasksCsv(file);
    e.target.value = '';
  });

  // riordino attività via trascinamento (delega sul tbody stabile)
  bindTaskDrag(el('tbl-tasks').querySelector('tbody'));

  // export Gantt + titolo PDF (persistito nel browser)
  el('gantt-titolo').value = state.ganttTitolo;
  el('gantt-titolo').addEventListener('input', () => {
    state.ganttTitolo = el('gantt-titolo').value;
    localStorage.setItem('ganttTitolo', state.ganttTitolo);
  });
  el('gantt-img').addEventListener('click', exportGanttImg);
  el('gantt-pdf').addEventListener('click', () => {
    const pdf = buildGanttPdf();
    if (!pdf) { alert('Nessuna attività da esportare.'); return; }
    downloadBlob(pdf, `gantt-${new Date().toISOString().slice(0, 10)}.pdf`);
  });

  // split ridimensionabile lista attività / Gantt
  let split = null;
  el('lavori-handle').addEventListener('pointerdown', e => {
    const pane = el('lavori-split').querySelector('.lv-tasks');
    split = { y: e.clientY, h: pane.offsetHeight, pane };
    el('lavori-handle').setPointerCapture?.(e.pointerId);
    e.preventDefault();
  });
  window.addEventListener('pointermove', e => {
    if (!split) return;
    const tot = el('lavori-split').clientHeight;
    let h = split.h + (e.clientY - split.y);
    h = Math.max(80, Math.min(h, tot - 120));
    split.pane.style.height = h + 'px';
  });
  window.addEventListener('pointerup', () => {
    if (!split) return;
    split = null;
    if (state.tasks.length) renderGantt(state.tasks); // ricalcola riempimento larghezza
  });

  // finestra date del Gantt: preset relativi
  document.querySelectorAll('.grng').forEach(btn => btn.addEventListener('click', () => {
    setGanttRange(btn.dataset.range);
  }));
  // finestra date del Gantt: date esatte
  el('gantt-from').addEventListener('change', () => {
    state.ganttFrom = el('gantt-from').value || null;
    state.ganttRangePreset = 'custom'; renderLavori();
  });
  el('gantt-to').addEventListener('change', () => {
    state.ganttTo = el('gantt-to').value || null;
    state.ganttRangePreset = 'custom'; renderLavori();
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
  if (nome === 'lavori') renderGantt(state.tasks); // ora il tab è visibile: il Gantt riempie la larghezza
}

// il Gantt si riadatta alla larghezza quando la finestra cambia
let resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (!el('tab-lavori').hidden && state.tasks.length) renderGantt(state.tasks);
  }, 150);
});

(async function init() {
  bindEvents();
  applyTheme(localStorage.getItem('theme') || 'light');
  setTab(location.hash.slice(1) || 'dashboard');
  await refresh({ global: true });
})();
