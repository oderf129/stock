/* Interface de l'application Stock & Commandes */
(function () {
  const E = window.Engine;
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
  const nf = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 1 });
  const n = (x) => (x == null || isNaN(x) ? '—' : nf.format(x));
  const DOW = ['Dim', 'Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam'];
  const fd = (s) => { if (!s) return '—'; const [y, m, d] = s.split('-'); return `${DOW[E.dow(s)]} ${d}/${m}`; };
  const fdl = (s) => { if (!s) return '—'; const [y, m, d] = s.split('-'); return `${d}/${m}/${y}`; };

  const empty = () => ({
    version: 1,
    settings: { closedDays: [], historyDays: 28, safetyDays: 1 },
    suppliers: [], items: [], counts: [], receipts: [], orders: [], recipes: [], sales: [],
  });
  let data = empty();
  let tab = 'dash';
  const ui = { countDate: E.todayStr(), consoFrom: E.addDays(E.todayStr(), -6), consoTo: E.todayStr(), editItem: null, editSup: null, receiveId: null };

  const today = () => E.todayStr();
  const supName = (id) => (data.suppliers.find((s) => s.id === id) || {}).name || 'Sans fournisseur';
  const itemById = (id) => data.items.find((i) => i.id === id);
  const activeItems = () => data.items.filter((i) => i.active !== false).sort((a, b) => a.name.localeCompare(b.name, 'fr'));
  const save = () => Store.save(data);
  // ── Quantités en lots (cartons) + unités ──
  const pk = (it) => (it && Number(it.packSize) > 1 ? Number(it.packSize) : 1);
  const lotName = (it) => (it && it.packLabel) || 'carton';
  const plural = (w, k) => (k > 1 && w && !/s$/.test(w) && !/^(kg|g|l|L|u\.?)$/.test(w) ? w + 's' : w);
  function fmtQ(it, q) {
    const p = pk(it), u = (it && it.unit) || '';
    if (p === 1 || !(q > 0)) return `${n(q)} ${esc(plural(u, q))}`;
    const l = Math.floor(q / p + 1e-9), r = Math.round((q - l * p) * 100) / 100;
    const parts = [];
    if (l) parts.push(`${l} ${esc(plural(lotName(it), l))}`);
    if (r) parts.push(`${n(r)} ${esc(plural(u, r))}`);
    return parts.join(' + ') + (l ? ` <span class="muted">(${n(q)} ${esc(plural(u, q))})</span>` : '');
  }
  // Saisie en unité de comptage (kg, poche…) : inventaires
  function qtyField(it, attr, total) {
    return `<span class="qty"><input type="number" min="0" step="any" inputmode="decimal" ${attr} value="${total ?? ''}"><span class="muted">${esc(plural(it.unit || '', 2))}</span></span>`;
  }
  // Saisie en unité de commande (carton) : commandes et réceptions
  function lotField(it, attr, total) {
    const p = pk(it);
    if (p === 1) return qtyField(it, attr, total);
    const l = total !== '' && total != null ? Math.round((total / p) * 100) / 100 : '';
    return `<span class="qty"><input type="number" min="0" step="1" inputmode="numeric" ${attr} data-pack="${p}" value="${l}"><span class="muted">${esc(plural(lotName(it), 2))} de ${n(p)} ${esc(plural(it.unit || '', p))}</span></span>`;
  }
  function readQty(el) {
    if (el.value === '') return null;
    return Number(el.value) * (Number(el.dataset.pack) || 1);
  }
  const toast = (msg) => { const t = $('#toast'); t.textContent = msg; t.classList.remove('hidden'); clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.add('hidden'), 2500); };
  const normalize = (d) => { const e = empty(); return { ...e, ...d, settings: { ...e.settings, ...(d.settings || {}) } }; };

  // ───────── Bandeau / compte ─────────
  function banner(msg, error) {
    const b = $('#banner');
    if (!msg) return b.classList.add('hidden');
    b.textContent = msg; b.classList.toggle('error', !!error); b.classList.remove('hidden');
  }
  function renderAccount() {
    const el = $('#account');
    if (Store.mode !== 'onedrive') { el.innerHTML = '<span>Mode local</span>'; return; }
    if (!Store.account) { el.innerHTML = '<button id="login">Se connecter à OneDrive</button>'; $('#login').onclick = () => Store.login(); return; }
    el.innerHTML = `<span class="status-dot ${Store.status}" title="${esc(Store.status)}"></span><span>${esc(Store.account.username)}</span><button id="logout" class="small">Déconnexion</button>`;
    $('#logout').onclick = () => Store.logout();
  }
  Store.onStatus = (s, msg) => {
    renderAccount();
    if (s === 'error') banner(msg, true); else if (s === 'saved') banner(Store.mode === 'local' ? localBanner() : '');
  };
  const localBanner = () => (window.APP_CONFIG && window.APP_CONFIG.clientId ? '' : 'Mode local : les données restent dans ce navigateur. Renseigne le clientId dans config.js pour synchroniser avec OneDrive (voir README).');

  // ───────── Tableau de bord : suggestions de commande ─────────
  function viewDash() {
    const t = today();
    const sugg = E.suggestAll(data, t);
    const pending = data.orders.filter((o) => o.status === 'pending');
    const nToday = sugg.filter((s) => s.status === 'today').length;
    const nRisk = sugg.filter((s) => s.status === 'risk').length;
    const groups = {};
    for (const s of sugg) {
      if (s.status === 'nocount' || s.status === 'norate') continue;
      const k = (s.supplier ? s.supplier.id : '_') + '|' + (s.orderDate || '');
      (groups[k] = groups[k] || { sup: s.supplier, orderDate: s.orderDate, deliveryDate: s.deliveryDate, asNeeded: s.asNeeded, plan: s.plan, rows: [] }).rows.push(s);
    }
    const okey = (g) => g.orderDate || '9999';
    const gl = Object.values(groups).sort((a, b) => (okey(a) < okey(b) ? -1 : okey(a) > okey(b) ? 1 : 0));
    const missing = sugg.filter((s) => s.status === 'nocount' || s.status === 'norate');
    const pill = (s) => ({
      risk: `<span class="pill risk">Rupture ${fd(s.ruptureDate)}</span>`,
      today: '<span class="pill today">À commander</span>',
      later: '<span class="pill later">Prévu</span>',
      ok: '<span class="pill ok">OK</span>',
    }[s.status]);

    let html = `<h2>Suggestions de commande</h2>
      <div class="kpis">
        <div class="kpi"><b>${nToday + nRisk}</b><span>références à commander maintenant</span></div>
        <div class="kpi"><b style="color:var(--bad)">${nRisk}</b><span>risques de rupture avant livraison</span></div>
        <div class="kpi"><b>${pending.length}</b><span>commandes en attente de réception</span></div>
      </div>`;
    if (!data.items.length) html += `<div class="card">Commence par créer tes <a href="#" data-go="suppliers">fournisseurs</a> et tes <a href="#" data-go="items">références</a>, puis fais un <a href="#" data-go="count">inventaire</a>. Il faut au moins deux inventaires pour calculer une consommation (ou une conso manuelle sur la référence).</div>`;

    gl.forEach((g, gi) => {
      const toOrder = g.rows.filter((r) => r.qty > 0).length;
      const worst = g.rows.some((r) => r.status === 'risk') ? 'risk' : g.orderDate === t && toOrder ? 'today' : '';
      const an = g.asNeeded;
      const head = an && !g.orderDate
        ? `<div class="muted">Commande <b>quand nécessaire</b> · aucune référence ne passe sous son seuil de sécurité dans les 4 prochains mois</div>`
        : an
        ? `<div class="muted">Commande <b>quand nécessaire</b> · jour conseillé : <b>${g.orderDate <= t ? "aujourd'hui" : fd(g.orderDate)}</b>${g.orderDate > t ? ' (au plus tard)' : ''} → livraison ${fd(g.deliveryDate)} · couvre jusqu'au ${fd(g.rows[0].nextDelivery)}</div>
           <div class="muted">${g.plan.late ? '<b style="color:var(--bad)">En retard :</b> ' : 'Déclenché par '}<b>${esc(g.plan.driver.name)}</b>, dont le stock théorique passe sous le seuil de sécurité le ${fd(g.plan.limitDate)} · ${toOrder} réf. à commander</div>`
        : `<div class="muted">Commander <b>${g.orderDate === t ? "aujourd'hui" : fd(g.orderDate)}</b> → livraison ${fd(g.deliveryDate)} · couvre jusqu'au ${fd(g.rows[0].nextDelivery)} (veille incluse) · ${toOrder} réf. à commander</div>`;
      html += `<div class="card supgroup ${worst}" data-group="${gi}">
        <div class="row" style="justify-content:space-between;align-items:center">
          <div><h3>${esc(g.sup ? g.sup.name : 'Sans fournisseur')}</h3>
          ${head}</div>
          ${toOrder ? `<button class="primary" data-validate="${gi}">${an && g.orderDate > t ? 'Commander dès maintenant' : 'Valider cette commande'}</button>` : ''}
        </div>
        <div class="table-wrap"><table><thead><tr>
          <th>Référence</th><th class="num">Stock estimé</th><th class="num hide-sm">Conso / jour</th><th class="num hide-sm">Jours restants</th>${an ? '<th class="num">Sous le seuil le</th>' : ''}<th class="num hide-sm">Stock à livraison</th><th class="num">À commander (cartons)</th><th>Statut</th>
        </tr></thead><tbody>
        ${g.rows.sort((a, b) => (an ? (a.limitDate || '9999') < (b.limitDate || '9999') ? -1 : (a.limitDate || '9999') > (b.limitDate || '9999') ? 1 : b.qty - a.qty : b.qty - a.qty)).map((s) => `<tr>
          <td><b>${esc(s.item.name)}</b><div class="muted">inv. ${fdl(s.lastCount.date)} : ${n(+s.lastCount.qty)} ${esc(plural(s.item.unit, +s.lastCount.qty))}</div></td>
          <td class="num">${n(Math.round(Math.max(0, s.stockNow)))} ${esc(plural(s.item.unit, 2))}</td>
          <td class="num hide-sm">${n(s.rate)}<div class="muted">${esc(s.rateSource)}</div></td>
          <td class="num hide-sm">${n(s.daysLeft)}</td>${an ? `<td class="num">${s.limitDate ? fd(s.limitDate) : '<span class="muted">&gt; 4 mois</span>'}<div class="muted">seuil ${n(Math.round((s.floor || 0) * 10) / 10)}</div></td>` : ''}
          <td class="num hide-sm">${s.stockAtDelivery != null ? n(Math.max(0, s.stockAtDelivery)) : '—'}</td>
          <td class="num" title="Besoin brut : ${n(s.need)} ${esc(s.item.unit)}">${g.orderDate ? lotField(s.item, `data-item="${s.item.id}"`, s.qty) : '—'}</td>
          <td>${pill(s)}</td></tr>`).join('')}
        </tbody></table></div></div>`;
    });

    if (missing.length) html += `<div class="card"><h3>Données insuffisantes</h3><div class="muted">Ces références n'ont pas encore assez d'inventaires (2 minimum) ou de conso manuelle :</div>
      <p>${missing.map((s) => `${esc(s.item.name)} <span class="pill na">${s.status === 'nocount' ? 'aucun inventaire' : '1 seul inventaire'}</span>`).join(' · ')}</p></div>`;

    if (pending.length) html += `<div class="card"><h3>Commandes en attente</h3>${pending.map(orderLine).join('')}<p><a href="#" data-go="receipts">Réceptionner →</a></p></div>`;

    if (gl.some((g) => g.asNeeded)) html += `<p class="muted">Fournisseurs « quand nécessaire » : le stock théorique part du dernier inventaire, baisse chaque jour selon les ventes Zelty × recettes (recalées sur l'écart réel constaté entre tes inventaires, ex. « ×1,1 inv. »), et la commande est conseillée le dernier jour possible pour être livré avant que la première référence passe sous son seuil de sécurité (stock minimum ou jours de sécurité). La commande couvre alors la couverture visée du fournisseur (14 j par défaut).</p>`;
    html += `<p class="muted">Calcul : conso moyenne par jour d'ouverture sur les ${data.settings.historyDays} derniers jours × (jours entre cette livraison et la suivante + stock de sécurité) − stock estimé à la livraison − commandes déjà en cours, arrondi au colis.</p>`;
    $('#view').innerHTML = html;

    $$('[data-validate]').forEach((b) => (b.onclick = () => {
      const g = gl[+b.dataset.validate];
      const card = b.closest('.card');
      const lines = $$('[data-item]', card).map((i) => ({ itemId: i.dataset.item, qty: readQty(i) || 0 })).filter((l) => l.qty > 0);
      if (!lines.length) return toast('Aucune quantité à commander');
      let dd = g.deliveryDate < t ? t : g.deliveryDate;
      if (g.asNeeded && g.orderDate > t) { const lead = Number(g.sup.leadDays) || 0; dd = g.sup.leadBusiness ? E.addBusinessDays(t, lead) : E.addDays(t, lead); }
      data.orders.push({ id: uid(), supplierId: g.sup ? g.sup.id : null, orderDate: t, deliveryDate: dd, lines, status: 'pending' });
      save(); toast('Commande enregistrée — à réceptionner à la livraison'); render();
    }));
  }
  function orderLine(o) {
    return `<div style="padding:6px 0;border-bottom:1px solid var(--line)"><b>${esc(supName(o.supplierId))}</b> · commandée ${fd(o.orderDate)} · livraison prévue ${fd(o.deliveryDate)}${o.deliveryDate < today() ? ' <span class="pill risk">en retard</span>' : ''}
      <div class="muted">${o.lines.map((l) => `${esc((itemById(l.itemId) || {}).name || '?')} : ${fmtQ(itemById(l.itemId), l.qty)}`).join(' · ')}</div></div>`;
  }

  // ───────── Inventaire ─────────
  function viewCount() {
    const d = ui.countDate;
    const items = activeItems();
    const bySup = {};
    for (const i of items) (bySup[i.supplierId || '_'] = bySup[i.supplierId || '_'] || []).push(i);
    let html = `<h2>Saisie d'inventaire</h2>
      <div class="card"><div class="row"><label>Date du relevé<input type="date" id="cdate" value="${d}"></label>
      <span class="muted" style="flex:1;min-width:200px">Saisis le stock réel ${data.settings.countTiming === 'morning' ? '<b>le matin, avant le service et avant la livraison du jour</b>' : '<b>en fin de journée</b> (livraisons du jour comprises)'}. Laisse vide les références non comptées.</span></div></div>`;
    for (const [sid, list] of Object.entries(bySup)) {
      html += `<div class="card"><h3>${esc(supName(sid))}</h3><div class="table-wrap"><table><thead><tr><th>Référence</th><th class="num hide-sm">Dernier inventaire</th><th class="num hide-sm">Estimé ce jour</th><th class="num">Stock compté</th></tr></thead><tbody>`;
      for (const i of list) {
        const ex = data.counts.find((c) => c.itemId === i.id && c.date === d);
        const prev = data.counts.filter((c) => c.itemId === i.id && c.date < d).sort((a, b) => (a.date < b.date ? 1 : -1))[0];
        const r = E.dailyRate(data, i, d).rate;
        const est = prev ? E.stockAt({ ...data, orders: [] }, i, data.settings.countTiming === 'morning' ? E.addDays(d, -1) : d, r, d) : null;
        html += `<tr><td><b>${esc(i.name)}</b></td>
          <td class="num hide-sm">${prev ? `${n(+prev.qty)} <span class="muted">(${fdl(prev.date)})</span>` : '—'}</td>
          <td class="num hide-sm">${est != null && r != null ? n(Math.max(0, est)) : '—'}</td>
          <td class="num">${qtyField(i, `data-count="${i.id}"`, ex ? ex.qty : '')}</td></tr>`;
      }
      html += '</tbody></table></div></div>';
    }
    if (!items.length) html += '<div class="card">Aucune référence active. <a href="#" data-go="items">Créer des références</a></div>';
    else html += '<button class="primary" id="saveCount">Enregistrer l\'inventaire</button>';

    const dates = [...new Set(data.counts.map((c) => c.date))].sort().reverse().slice(0, 15);
    if (dates.length) html += `<div class="card" style="margin-top:14px"><h3>Inventaires enregistrés</h3>${dates.map((x) => `<div class="row" style="justify-content:space-between;padding:4px 0;border-bottom:1px solid var(--line)"><span>${fdl(x)} — ${data.counts.filter((c) => c.date === x).length} réf.</span><span><button class="small" data-opencount="${x}">Ouvrir</button> <button class="small danger" data-delcount="${x}">Supprimer</button></span></div>`).join('')}</div>`;
    $('#view').innerHTML = html;

    $('#cdate').onchange = (e) => { ui.countDate = e.target.value || today(); render(); };
    const sb = $('#saveCount');
    if (sb) sb.onclick = () => {
      let k = 0;
      for (const inp of $$('[data-count]')) {
        const id = inp.dataset.count;
        data.counts = data.counts.filter((c) => !(c.itemId === id && c.date === d));
        const q = readQty(inp);
        if (q != null) { data.counts.push({ id: uid(), date: d, itemId: id, qty: q }); k++; }
      }
      save(); toast(`Inventaire du ${fdl(d)} enregistré (${k} réf.)`); render();
    };
    $$('[data-opencount]').forEach((b) => (b.onclick = () => { ui.countDate = b.dataset.opencount; render(); }));
    $$('[data-delcount]').forEach((b) => (b.onclick = () => {
      if (!confirm(`Supprimer l'inventaire du ${fdl(b.dataset.delcount)} ?`)) return;
      data.counts = data.counts.filter((c) => c.date !== b.dataset.delcount); save(); render();
    }));
  }

  // ───────── Réceptions ─────────
  function viewReceipts() {
    const pending = data.orders.filter((o) => o.status === 'pending').sort((a, b) => (a.deliveryDate < b.deliveryDate ? -1 : 1));
    let html = '<h2>Réceptions de marchandise</h2>';
    html += `<div class="card"><h3>Commandes en attente</h3>${pending.length ? '' : '<div class="muted">Aucune commande en attente. Valide une suggestion dans l\'onglet Commandes.</div>'}`;
    for (const o of pending) {
      if (ui.receiveId === o.id) {
        html += `<div class="card" style="background:var(--bg)"><b>${esc(supName(o.supplierId))}</b> — réception
          <div class="row" style="margin:8px 0"><label>Date de réception<input type="date" id="rdate" value="${o.deliveryDate <= today() ? o.deliveryDate : today()}"></label></div>
          <table><tbody>${o.lines.map((l) => `<tr><td>${esc((itemById(l.itemId) || {}).name)}</td><td class="num">commandé ${fmtQ(itemById(l.itemId), l.qty)}</td><td class="num">${lotField(itemById(l.itemId) || {}, `data-rline="${l.itemId}"`, l.qty)}</td></tr>`).join('')}</tbody></table>
          <div class="row" style="margin-top:8px"><button class="primary" id="confirmRec">Confirmer la réception</button><button id="cancelRec">Annuler</button></div></div>`;
      } else {
        html += `<div class="row" style="justify-content:space-between;align-items:center">${orderLine(o)}<span><button class="small primary" data-rec="${o.id}">Réceptionner</button> <button class="small danger" data-delorder="${o.id}">Annuler la commande</button></span></div>`;
      }
    }
    html += '</div>';
    html += `<div class="card"><h3>Réception hors commande</h3><div class="row">
      <label>Date<input type="date" id="mdate" value="${today()}"></label>
      <label>Référence<select id="mitem">${activeItems().map((i) => `<option value="${i.id}">${esc(i.name)} (${esc(i.unit)})</option>`).join('')}</select></label>
      <label>Cartons<input type="number" id="mlot" min="0" step="1" style="width:80px"></label>
      <button class="primary" id="addRec">Ajouter</button></div></div>`;
    const recent = [...data.receipts].sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, 40);
    if (recent.length) html += `<div class="card"><h3>Dernières réceptions</h3><div class="table-wrap"><table><thead><tr><th>Date</th><th>Référence</th><th class="num">Qté</th><th></th></tr></thead><tbody>
      ${recent.map((r) => `<tr><td>${fdl(r.date)}</td><td>${esc((itemById(r.itemId) || {}).name || '?')}</td><td class="num">${fmtQ(itemById(r.itemId), +r.qty)}</td><td class="num"><button class="small danger" data-delrec="${r.id}">✕</button></td></tr>`).join('')}
      </tbody></table></div></div>`;
    $('#view').innerHTML = html;

    $$('[data-rec]').forEach((b) => (b.onclick = () => { ui.receiveId = b.dataset.rec; render(); }));
    $$('[data-delorder]').forEach((b) => (b.onclick = () => { if (confirm('Annuler cette commande ?')) { data.orders = data.orders.filter((o) => o.id !== b.dataset.delorder); save(); render(); } }));
    if ($('#cancelRec')) $('#cancelRec').onclick = () => { ui.receiveId = null; render(); };
    if ($('#confirmRec')) $('#confirmRec').onclick = () => {
      const o = data.orders.find((x) => x.id === ui.receiveId);
      const d = $('#rdate').value || today();
      for (const inp of $$('[data-rline]')) { const q = readQty(inp); if (q > 0) data.receipts.push({ id: uid(), date: d, itemId: inp.dataset.rline, qty: q, orderId: o.id }); }
      o.status = 'received'; o.receivedDate = d; ui.receiveId = null; save(); toast('Réception enregistrée'); render();
    };
    $('#addRec').onclick = () => {
      const q = Number($('#mlot').value || 0) * pk(itemById($('#mitem').value));
      if (!(q > 0) || !$('#mitem').value) return toast('Quantité invalide');
      data.receipts.push({ id: uid(), date: $('#mdate').value || today(), itemId: $('#mitem').value, qty: q }); save(); toast('Réception ajoutée'); render();
    };
    $$('[data-delrec]').forEach((b) => (b.onclick = () => { data.receipts = data.receipts.filter((r) => r.id !== b.dataset.delrec); save(); render(); }));
  }

  // ───────── Consommation ─────────
  function viewConso() {
    const { consoFrom: f, consoTo: t } = ui;
    const rows = activeItems().map((i) => ({ i, c: E.consumption(data, i.id, f, t), th: (data.recipes || []).some((r) => r.itemId === i.id) ? E.theoConsumption(data, i.id, f, t) : null }));
    const td = today();
    const first = td.slice(0, 8) + '01';
    const prevLast = E.addDays(first, -1);
    const presets = [
      ['7 jours', E.addDays(td, -6), td], ['14 jours', E.addDays(td, -13), td], ['30 jours', E.addDays(td, -29), td],
      ['Mois en cours', first, td], ['Mois dernier', prevLast.slice(0, 8) + '01', prevLast],
    ];
    let html = `<h2>Consommation sur une période</h2>
      <div class="card"><div class="row">
        <label>Du<input type="date" id="cf" value="${f}"></label><label>Au<input type="date" id="ct" value="${t}"></label>
        ${presets.map((p, k) => `<button class="small" data-preset="${k}">${p[0]}</button>`).join('')}
        <button class="small" id="csv">Exporter CSV</button></div>
        <div class="muted" style="margin-top:8px">Conso = stock début + réceptions − stock fin, entre deux inventaires, répartie au prorata des jours d'ouverture. « Couverture » = part de la période couverte par des inventaires. « Selon ventes » = plats vendus (caisse Zelty) × recettes ; un écart de plus de 10 % signale une perte, une portion différente ou une erreur de comptage (comparer sur des périodes entières entre deux inventaires).</div></div>
      <div class="card table-wrap"><table><thead><tr><th>Référence</th><th class="num">Consommé</th><th class="num">Moy. / jour ouvert</th><th class="num hide-sm">Moy. / semaine</th><th class="num hide-sm">Reçu</th><th class="num">Selon ventes</th><th class="num">Écart</th><th>Couverture</th></tr></thead><tbody>
      ${rows.map(({ i, c, th }) => {
        const ec = th && th.days && c.covered ? (c.total - th.total) / th.total : null;
        const open = data.settings.closedDays.length ? 7 - data.settings.closedDays.length : 7;
        return `<tr><td><b>${esc(i.name)}</b><div class="muted">${esc(supName(i.supplierId))}</div></td>
          <td class="num">${c.covered ? n(c.total) + ' ' + esc(i.unit) : '—'}</td>
          <td class="num">${n(c.perDay)}</td>
          <td class="num hide-sm">${c.perDay != null ? n(c.perDay * open) : '—'}</td>
          <td class="num hide-sm">${n(c.received)}</td>
          <td class="num">${th && th.days ? n(th.total) + `<div class="muted">mêmes ${th.days} j</div>` : '<span class="muted">—</span>'}</td>
          <td class="num">${ec == null ? '—' : `<span class="pill ${Math.abs(ec) > 0.1 ? 'risk' : 'ok'}">${ec > 0 ? '+' : ''}${Math.round(ec * 100)} %</span>`}</td>
          <td><div class="bar" title="${Math.round(c.coverage * 100)} %"><i style="width:${Math.round(c.coverage * 100)}%"></i></div><span class="muted">${c.covered}/${c.periodOpen} j</span>${c.unexplained ? `<div class="muted" style="color:var(--warn)" title="Le stock a augmenté entre deux inventaires sans réception saisie : ces jours sont ignorés">⚠ ${c.unexplained} livraison(s) manquante(s)</div>` : ''}</td></tr>`;
      }).join('')}
      </tbody></table></div>`;
    $('#view').innerHTML = html;
    $('#cf').onchange = (e) => { ui.consoFrom = e.target.value; render(); };
    $('#ct').onchange = (e) => { ui.consoTo = e.target.value; render(); };
    $$('[data-preset]').forEach((b) => (b.onclick = () => { const p = presets[+b.dataset.preset]; ui.consoFrom = p[1]; ui.consoTo = p[2]; render(); }));
    $('#csv').onclick = () => {
      const lines = [['Référence', 'Unité', 'Fournisseur', 'Consommé', 'Moyenne par jour ouvert', 'Reçu', 'Jours couverts', "Jours d'ouverture"].join(';')];
      for (const { i, c } of rows) lines.push([i.name, i.unit, supName(i.supplierId), c.total.toFixed(2), c.perDay != null ? c.perDay.toFixed(2) : '', c.received, c.covered, c.periodOpen].map((v) => `"${String(v).replace('.', ',').replace(/"/g, '""')}"`).join(';'));
      download(`consommation_${f}_${t}.csv`, '﻿' + lines.join('\n'), 'text/csv');
    };
  }

  // ───────── Références ─────────
  function viewItems() {
    const e = ui.editItem ? data.items.find((i) => i.id === ui.editItem) || {} : {};
    const sups = data.suppliers;
    let html = `<h2>Références suivies</h2>
      <div class="card"><h3>${ui.editItem ? 'Modifier' : 'Nouvelle référence'}</h3>
      <form id="itemForm" class="row">
        <label>Nom<input name="name" required value="${esc(e.name)}" placeholder="ex. Riz jasmin"></label>
        <label>Unité<input name="unit" value="${esc(e.unit || 'kg')}" style="width:80px" placeholder="kg, L, pièce…"></label>
        <label>Fournisseur<select name="supplierId"><option value="">—</option>${sups.map((s) => `<option value="${s.id}" ${s.id === e.supplierId ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select></label>
        <label>Unités par lot<input type="number" name="packSize" step="any" min="0" value="${e.packSize ?? 1}" title="Ex. 30 poches par carton : la commande est arrondie au lot supérieur, et l'inventaire peut se saisir en lots + unités"></label>
        <label>Nom du lot<input name="packLabel" value="${esc(e.packLabel || 'carton')}" style="width:90px"></label>
        <label>Stock sécurité (j)<input type="number" name="safetyDays" step="any" min="0" value="${e.safetyDays ?? ''}" placeholder="défaut ${data.settings.safetyDays}"></label>
        <label>Commande min.<input type="number" name="minOrder" step="any" min="0" value="${e.minOrder ?? ''}"></label>
        <label>Stock minimum<input type="number" name="minStock" step="any" min="0" value="${e.minStock ?? ''}" title="Stock à garder en permanence (ex. stock de sécurité d'un produit fait maison)"></label>
        <label>Conso manuelle / j<input type="number" name="manualRate" step="any" min="0" value="${e.manualRate ?? ''}" title="Optionnel : force la conso journalière au lieu du calcul"></label>
        <label>Active<select name="active"><option value="1">Oui</option><option value="0" ${e.active === false ? 'selected' : ''}>Non</option></select></label>
        <button class="primary">${ui.editItem ? 'Enregistrer' : 'Ajouter'}</button>
        ${ui.editItem ? '<button type="button" id="cancelItem">Annuler</button>' : ''}
      </form>${!sups.length ? '<p class="muted">Astuce : crée d\'abord tes fournisseurs pour regrouper les commandes.</p>' : ''}</div>
      <div class="card table-wrap"><table><thead><tr><th>Nom</th><th>Fournisseur</th><th class="num">Lot</th><th class="num hide-sm">Sécu (j)</th><th class="num hide-sm">Conso / j</th><th></th></tr></thead><tbody>
      ${[...data.items].sort((a, b) => a.name.localeCompare(b.name, 'fr')).map((i) => `<tr style="${i.active === false ? 'opacity:.5' : ''}"><td><b>${esc(i.name)}</b> <span class="muted">${esc(i.unit)}</span></td><td>${esc(supName(i.supplierId))}</td><td class="num">${pk(i) > 1 ? `${esc(lotName(i))} de ${n(pk(i))}` : "—"}</td><td class="num hide-sm">${i.safetyDays === '' || i.safetyDays == null ? '<span class="muted">' + data.settings.safetyDays + '</span>' : n(+i.safetyDays)}</td><td class="num hide-sm">${n(E.dailyRate(data, i, today()).rate)}</td>
        <td class="num"><button class="small" data-edit="${i.id}">Modifier</button> <button class="small danger" data-del="${i.id}">✕</button></td></tr>`).join('')}
      </tbody></table></div>`;
    $('#view').innerHTML = html;
    $('#itemForm').onsubmit = (ev) => {
      ev.preventDefault();
      const fdat = Object.fromEntries(new FormData(ev.target));
      const obj = { name: fdat.name.trim(), unit: fdat.unit.trim(), supplierId: fdat.supplierId || null, packSize: Number(fdat.packSize) || 1, packLabel: (fdat.packLabel || 'carton').trim(),
        safetyDays: fdat.safetyDays === '' ? '' : Number(fdat.safetyDays), minOrder: fdat.minOrder === '' ? '' : Number(fdat.minOrder), minStock: fdat.minStock === '' ? '' : Number(fdat.minStock),
        manualRate: fdat.manualRate === '' ? '' : Number(fdat.manualRate), active: fdat.active === '1' };
      if (ui.editItem) Object.assign(data.items.find((i) => i.id === ui.editItem), obj); else data.items.push({ id: uid(), ...obj });
      ui.editItem = null; save(); toast('Référence enregistrée'); render();
    };
    if ($('#cancelItem')) $('#cancelItem').onclick = () => { ui.editItem = null; render(); };
    $$('[data-edit]').forEach((b) => (b.onclick = () => { ui.editItem = b.dataset.edit; render(); window.scrollTo(0, 0); }));
    $$('[data-del]').forEach((b) => (b.onclick = () => {
      if (!confirm('Supprimer cette référence et tout son historique ? (Pour la masquer sans perdre l\'historique, passe-la en « Active : Non »)')) return;
      const id = b.dataset.del;
      data.items = data.items.filter((i) => i.id !== id); data.counts = data.counts.filter((c) => c.itemId !== id); data.receipts = data.receipts.filter((r) => r.itemId !== id);
      save(); render();
    }));
  }

  // ───────── Fournisseurs ─────────
  function viewSuppliers() {
    const e = ui.editSup ? data.suppliers.find((s) => s.id === ui.editSup) || {} : {};
    const od = e.orderDays || [];
    let html = `<h2>Fournisseurs</h2>
      <div class="card"><h3>${ui.editSup ? 'Modifier' : 'Nouveau fournisseur'}</h3>
      <form id="supForm" class="row">
        <label>Nom<input name="name" required value="${esc(e.name)}" placeholder="ex. Metro"></label>
        <label>Type de commande<select name="mode"><option value="fixed">Jours fixes</option><option value="asNeeded" ${e.mode === 'asNeeded' ? 'selected' : ''}>Quand nécessaire</option></select></label>
        <label>Jours où je peux commander<div class="days">${[1, 2, 3, 4, 5, 6, 0].map((d) => `<label><input type="checkbox" name="od" value="${d}" ${od.includes(d) ? 'checked' : ''}>${DOW[d]}</label>`).join('')}</div></label>
        <label>Délai de livraison (jours)<input type="number" name="leadDays" min="0" step="1" value="${e.leadDays ?? 1}"></label>
        <label>Délai compté en<select name="leadBusiness"><option value="0">jours calendaires</option><option value="1" ${e.leadBusiness ? 'selected' : ''}>jours ouvrés (lun-ven)</option></select></label>
        <label>Couverture visée (jours)<input type="number" name="coverDays" min="0" step="1" value="${e.coverDays ?? ''}" placeholder="jusqu'à la livraison suivante" title="Pour un fournisseur commandé moins souvent (ex. 21 = commandes toutes les 3 semaines) : la commande ne se déclenche que si le stock ne tient pas jusqu'à la prochaine livraison possible, et couvre alors ce nombre de jours."></label>
        <label style="flex:1;min-width:180px">Contact / notes<input name="notes" value="${esc(e.notes)}"></label>
        <button class="primary">${ui.editSup ? 'Enregistrer' : 'Ajouter'}</button>
        ${ui.editSup ? '<button type="button" id="cancelSup">Annuler</button>' : ''}
      </form><p class="muted">« Quand nécessaire » : l'app calcule le jour de commande selon le stock théorique (ex. surgelés) ; les jours cochés sont alors les jours où le fournisseur accepte une commande. Aucun jour coché = commande possible tous les jours. Délai 1 = commande lundi, livraison mardi. Couverture vide = chaque commande couvre jusqu'à la livraison suivante.</p></div>
      <div class="card table-wrap"><table><thead><tr><th>Nom</th><th>Jours de commande</th><th class="num">Délai</th><th class="hide-sm">Notes</th><th></th></tr></thead><tbody>
      ${data.suppliers.map((s) => `<tr><td><b>${esc(s.name)}</b><div class="muted">${data.items.filter((i) => i.supplierId === s.id).length} réf.</div></td><td>${s.mode === 'asNeeded' ? '<b>Quand nécessaire</b><div class="muted">' : ''}${(s.orderDays || []).length ? [1, 2, 3, 4, 5, 6, 0].filter((d) => s.orderDays.includes(d)).map((d) => DOW[d]).join(', ') : 'tous les jours'}${s.mode === 'asNeeded' ? '</div>' : ''}</td><td class="num">${s.leadDays} j${s.leadBusiness ? ' ouvrés' : ''}${Number(s.coverDays) > 0 ? `<div class="muted">couvre ${s.coverDays} j</div>` : ''}</td><td class="hide-sm muted">${esc(s.notes)}</td>
        <td class="num"><button class="small" data-edit="${s.id}">Modifier</button> <button class="small danger" data-del="${s.id}">✕</button></td></tr>`).join('')}
      </tbody></table></div>`;
    $('#view').innerHTML = html;
    $('#supForm').onsubmit = (ev) => {
      ev.preventDefault();
      const fm = new FormData(ev.target);
      const obj = { name: fm.get('name').trim(), mode: fm.get('mode') === 'asNeeded' ? 'asNeeded' : 'fixed', orderDays: fm.getAll('od').map(Number), leadDays: Number(fm.get('leadDays')) || 0, leadBusiness: fm.get('leadBusiness') === '1', coverDays: fm.get('coverDays') === '' ? '' : Number(fm.get('coverDays')), notes: fm.get('notes') };
      if (ui.editSup) Object.assign(data.suppliers.find((s) => s.id === ui.editSup), obj); else data.suppliers.push({ id: uid(), ...obj });
      ui.editSup = null; save(); toast('Fournisseur enregistré'); render();
    };
    if ($('#cancelSup')) $('#cancelSup').onclick = () => { ui.editSup = null; render(); };
    $$('[data-edit]').forEach((b) => (b.onclick = () => { ui.editSup = b.dataset.edit; render(); }));
    $$('[data-del]').forEach((b) => (b.onclick = () => {
      if (!confirm('Supprimer ce fournisseur ? Ses références seront conservées, sans fournisseur.')) return;
      data.suppliers = data.suppliers.filter((s) => s.id !== b.dataset.del);
      data.items.forEach((i) => { if (i.supplierId === b.dataset.del) i.supplierId = null; });
      save(); render();
    }));
  }

  // ───────── Réglages ─────────
  function viewSettings() {
    const s = data.settings;
    $('#view').innerHTML = `<h2>Réglages</h2>
      <div class="card"><h3>Calculs</h3><form id="setForm" class="row">
        <label>Jours de fermeture du restaurant<div class="days">${[1, 2, 3, 4, 5, 6, 0].map((d) => `<label><input type="checkbox" name="cd" value="${d}" ${s.closedDays.includes(d) ? 'checked' : ''}>${DOW[d]}</label>`).join('')}</div></label>
        <label>Historique pour la moyenne (jours)<input type="number" name="historyDays" min="7" value="${s.historyDays}"></label>
        <label>Mes inventaires sont faits<select name="countTiming"><option value="end">le soir (livraisons du jour comprises)</option><option value="morning" ${s.countTiming === 'morning' ? 'selected' : ''}>le matin, avant service et livraisons</option></select></label>
        <label>Stock de sécurité par défaut (jours)<input type="number" name="safetyDays" min="0" step="any" value="${s.safetyDays}"></label>
        <button class="primary">Enregistrer</button></form>
        <p class="muted">Les jours de fermeture ne consomment rien : la conso est calculée par jour d'ouverture.</p></div>
      <div class="card"><h3>Stockage</h3>
        <p>${Store.mode === 'onedrive' ? (Store.account ? `Synchronisé avec OneDrive (<b>${esc(Store.account.username)}</b>) — fichier <code>OneDrive/Applications/…/${esc(window.APP_CONFIG.fileName)}</code>` : 'OneDrive configuré, non connecté.') : 'Mode local (ce navigateur uniquement).'}</p>
        <p class="muted">Dernière modification : ${data.updatedAt ? new Date(data.updatedAt).toLocaleString('fr-FR') : '—'}</p>
        <div class="row"><button id="expx">Télécharger le fichier Excel</button><button id="exp">Sauvegarde JSON</button>
        <label class="row" style="align-items:center"><span>Importer (Excel ou JSON) :</span><input type="file" id="imp" accept=".xlsx,.json,application/json"></label></div>
        <p class="muted">Le classeur contient un onglet par type de donnée (Inventaires, Réceptions, Commandes, Références, Fournisseurs) et une Synthèse recalculée à chaque enregistrement. Tu peux y ajouter ou corriger des lignes dans Excel : l'app les relit à l'ouverture.</p></div>
      <div class="card"><h3>Démo</h3><div class="row">
        <button id="demo">Charger des données d'exemple</button><button class="danger" id="reset">Tout effacer</button></div>
        <p class="muted">Les données d'exemple remplacent les données actuelles (exporte une sauvegarde avant).</p></div>`;
    $('#setForm').onsubmit = (ev) => {
      ev.preventDefault(); const fm = new FormData(ev.target);
      Object.assign(data.settings, { countTiming: fm.get('countTiming'), closedDays: fm.getAll('cd').map(Number), historyDays: Number(fm.get('historyDays')) || 28, safetyDays: Number(fm.get('safetyDays')) || 0 });
      save(); toast('Réglages enregistrés');
    };
    $('#exp').onclick = () => download(`stock-sauvegarde-${today()}.json`, JSON.stringify(data, null, 1), 'application/json');
    $('#expx').onclick = () => download(`Stock MLW ${today()}.xlsx`, XLSX.write(XlsxIO.toWorkbook(XLSX, data, E), { type: 'array', bookType: 'xlsx' }), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    $('#imp').onchange = async (ev) => {
      const f = ev.target.files[0]; if (!f) return;
      try { const d = /\.xlsx$/i.test(f.name) ? XlsxIO.fromWorkbook(XLSX, XLSX.read(await f.arrayBuffer(), { type: 'array', cellDates: true })) : JSON.parse(await f.text()); if (!d.items || !d.items.length) throw 0; if (!confirm('Remplacer toutes les données par ce fichier ?')) return; data = normalize(d); save(); toast('Import réussi'); render(); }
      catch { alert('Fichier invalide'); }
    };
    $('#demo').onclick = () => { if (confirm('Remplacer les données par l\'exemple ?')) { data = demoData(); save(); tab = 'dash'; render(); } };
    $('#reset').onclick = () => { if (confirm('Effacer TOUTES les données ?')) { data = empty(); save(); render(); } };
  }

  function demoData() {
    const d = empty();
    d.settings.closedDays = [0];
    const t = today();
    d.suppliers = [
      { id: 's1', name: 'Grossiste asiatique', orderDays: [1, 4], leadDays: 2, notes: '' },
      { id: 's2', name: 'Metro', orderDays: [], leadDays: 0, notes: 'Retrait sur place' },
      { id: 's3', name: 'Primeur', orderDays: [1, 3, 5], leadDays: 1, notes: '' },
    ];
    d.items = [
      { id: 'i1', name: 'Riz jasmin', unit: 'kg', supplierId: 's1', packSize: 20, safetyDays: '', minOrder: '', manualRate: '', active: true, rate: 9 },
      { id: 'i2', name: 'Lait de coco', unit: 'L', supplierId: 's1', packSize: 12, safetyDays: 2, minOrder: '', manualRate: '', active: true, rate: 4 },
      { id: 'i3', name: 'Nouilles de riz', unit: 'kg', supplierId: 's1', packSize: 10, safetyDays: '', minOrder: '', manualRate: '', active: true, rate: 3 },
      { id: 'i4', name: 'Poulet (cuisse)', unit: 'kg', supplierId: 's2', packSize: 5, safetyDays: 1, minOrder: '', manualRate: '', active: true, rate: 7 },
      { id: 'i5', name: 'Huile de friture', unit: 'L', supplierId: 's2', packSize: 10, safetyDays: '', minOrder: '', manualRate: '', active: true, rate: 2.5 },
      { id: 'i6', name: 'Citron vert', unit: 'kg', supplierId: 's3', packSize: 1, safetyDays: 1, minOrder: '', manualRate: '', active: true, rate: 1.2 },
    ];
    // Simule 5 semaines d'inventaires (lundi & jeudi) et de livraisons
    const stock = { i1: 60, i2: 30, i3: 25, i4: 30, i5: 20, i6: 6 };
    for (let k = 35; k >= 1; k--) {
      const day = E.addDays(t, -k);
      if (E.isOpen(d, day)) for (const it of d.items) stock[it.id] -= it.rate * (0.8 + Math.random() * 0.4);
      for (const it of d.items) if (stock[it.id] < it.rate * 3) { const q = it.packSize * Math.ceil((it.rate * 6) / it.packSize); stock[it.id] += q; d.receipts.push({ id: uid(), date: day, itemId: it.id, qty: q }); }
      if ([1, 4].includes(E.dow(day))) for (const it of d.items) d.counts.push({ id: uid(), date: day, itemId: it.id, qty: Math.round(Math.max(0, stock[it.id]) * 10) / 10 });
    }
    d.items.forEach((i) => delete i.rate);
    return d;
  }

  function download(name, content, type) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([content], { type }));
    a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  // ───────── Navigation ─────────
  // ───────── Recettes : plats vendus → produits ─────────
  function viewRecipes() {
    const idx = E.salesIndex(data);
    const dishes = {};
    for (const r of data.sales || []) dishes[r.dish] = (dishes[r.dish] || 0) + Number(r.qty || 0);
    const dishList = Object.entries(dishes).sort((a, b) => b[1] - a[1]);
    const nbDays = Object.keys(idx.byDay).length;
    let html = `<h2>Recettes</h2>
      <div class="card"><p class="muted">Indique quels plats utilisent quel produit, et combien par plat. L'app calcule alors la consommation à partir des ventes de la caisse et prévoit les commandes selon tes jours forts.</p>
      <form id="recForm" class="row">
        <label style="flex:1;min-width:200px">Plat (tel que vendu en caisse)<input name="dish" list="dishlist" required placeholder="ex. PORC AU CARAMEL"><datalist id="dishlist">${dishList.map(([d]) => `<option value="${esc(d)}">`).join('')}</datalist></label>
        <label>Produit utilisé<select name="itemId">${activeItems().map((i) => `<option value="${i.id}">${esc(i.name)}</option>`).join('')}</select></label>
        <label>Quantité par plat<input type="number" name="qty" step="any" min="0" value="1"></label>
        <button class="primary">Ajouter</button></form></div>
      <div class="card table-wrap"><table><thead><tr><th>Plat</th><th>Produit</th><th class="num">Par plat</th><th class="num">Vendus / jour</th><th></th></tr></thead><tbody>
      ${(data.recipes || []).map((r, k) => { const it = itemById(r.itemId) || {}; return `<tr><td>${esc(r.dish)}</td><td>${esc(it.name || '?')}</td><td class="num">${n(+r.qty)} ${esc(plural(it.unit || '', +r.qty))}</td><td class="num">${nbDays ? n((dishes[r.dish] || 0) / nbDays) : '—'}</td><td class="num"><button class="small danger" data-delrec="${k}">✕</button></td></tr>`; }).join('') || '<tr><td colspan="5" class="muted">Aucune recette pour l\'instant.</td></tr>'}
      </tbody></table></div>
      <div class="card"><h3>Ventes enregistrées</h3><p>${nbDays ? `${nbDays} jours de ventes, jusqu'au ${fdl(idx.last)}.` : 'Aucune vente importée.'}</p>
        <div class="row"><label class="row" style="align-items:center"><span>Importer des ventes (Excel : Date, Plat, Quantité) :</span><input type="file" id="impSales" accept=".xlsx,.csv"></label></div>
        <p class="muted">Les jours présents dans le fichier remplacent ceux déjà enregistrés.</p></div>`;
    $('#view').innerHTML = html;
    $('#recForm').onsubmit = (ev) => {
      ev.preventDefault(); const fm = new FormData(ev.target);
      (data.recipes = data.recipes || []).push({ dish: fm.get('dish').trim(), itemId: fm.get('itemId'), qty: Number(fm.get('qty')) || 1 });
      save(); toast('Recette ajoutée'); render();
    };
    $$('[data-delrec]').forEach((b) => (b.onclick = () => { data.recipes.splice(+b.dataset.delrec, 1); save(); render(); }));
    $('#impSales').onchange = async (ev) => {
      const f = ev.target.files[0]; if (!f) return;
      try {
        const wb = XLSX.read(await f.arrayBuffer(), { type: 'array', cellDates: true });
        const ws = wb.Sheets['Ventes'] || wb.Sheets[wb.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json(ws, { defval: '' }).map((r) => ({ date: XlsxIO.fromXDate(r['Date']), dish: String(r['Plat'] || '').trim(), qty: Number(r['Quantité'] ?? r['Quantite'] ?? 0) })).filter((r) => r.date && r.dish && r.qty);
        if (!rows.length) throw 0;
        const days = new Set(rows.map((r) => r.date));
        data.sales = (data.sales || []).filter((r) => !days.has(r.date)).concat(rows);
        save(); toast(`${days.size} jours de ventes importés`); render();
      } catch { toast('Fichier de ventes invalide'); }
    };
  }

  // Point d'entrée pour une synchronisation automatique des ventes (tâche planifiée)
  window.StockApp = {
    importSales(rows) {
      const ok = (rows || []).filter((r) => r && r.date && r.dish && Number(r.qty) > 0);
      const days = new Set(ok.map((r) => r.date));
      data.sales = (data.sales || []).filter((r) => !days.has(r.date)).concat(ok.map((r) => ({ date: r.date, dish: String(r.dish), qty: Number(r.qty) })));
      save(); render();
      return { days: days.size, rows: ok.length, last: E.salesIndex(data).last, status: Store.status };
    },
    info() { return { account: Store.account && Store.account.username, status: Store.status, salesLast: E.salesIndex(data).last, counts: data.counts.length }; },
  };

  const views = { recipes: viewRecipes, dash: viewDash, count: viewCount, receipts: viewReceipts, conso: viewConso, items: viewItems, suppliers: viewSuppliers, settings: viewSettings };
  function render() {
    $$('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
    views[tab]();
    $$('[data-go]').forEach((a) => (a.onclick = (e) => { e.preventDefault(); tab = a.dataset.go; render(); }));
  }
  $$('#tabs button').forEach((b) => (b.onclick = () => { tab = b.dataset.tab; render(); }));

  // ───────── Démarrage ─────────
  (async function start() {
    const cached = Store.readCache();
    if (cached) data = normalize(cached);
    try { await Store.init(); } catch (e) { console.error(e); banner('Erreur de connexion Microsoft : ' + e.message, true); }
    renderAccount();
    render();
    if (Store.mode === 'local') return banner(localBanner());
    if (!Store.account) return banner('Connecte-toi à OneDrive (en haut à droite) pour retrouver tes données sur tous tes appareils.');
    try {
      const remote = await Store.loadRemote();
      if (!remote) {
        if (data.items.length) { Store.save(data); toast('Données envoyées sur OneDrive'); }
      } else if (cached && cached.updatedAt && remote.updatedAt && cached.updatedAt > remote.updatedAt) {
        Store.save(data); toast('Modifications hors ligne synchronisées');
      } else {
        data = normalize(remote);
      }
      render();
    } catch (e) {
      console.error(e);
      banner('Impossible de joindre OneDrive — affichage des données de cet appareil.', true);
    }
  })();
})();
