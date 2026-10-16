/* Moteur de calcul : consommation, stock estimé, suggestions de commande.
 * Convention : un relevé de stock = quantité EN FIN DE JOURNÉE (après livraisons du jour),
 * ou le MATIN avant service et livraisons si settings.countTiming === 'morning'.
 * Les dates sont des chaînes 'AAAA-MM-JJ'. */
(function (root) {
  const DAY = 86400000;
  const toTime = (s) => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10));
  const fromTime = (t) => new Date(t).toISOString().slice(0, 10);
  const addDays = (s, n) => fromTime(toTime(s) + n * DAY);
  const diffDays = (a, b) => Math.round((toTime(b) - toTime(a)) / DAY); // b - a
  const dow = (s) => new Date(toTime(s)).getUTCDay(); // 0 = dimanche
  const todayStr = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };

  function isOpen(data, s) {
    return !((data.settings && data.settings.closedDays) || []).includes(dow(s));
  }
  // Jours d'ouverture dans l'intervalle (a, b]
  function openDays(data, a, b) {
    let n = 0;
    for (let d = addDays(a, 1); d <= b; d = addDays(d, 1)) if (isOpen(data, d)) n++;
    return n;
  }

  // Inventaire fait le matin (avant service et livraisons) = équivaut à un inventaire de fin de journée la veille
  const sh = (data, d) => (data.settings && data.settings.countTiming === 'morning' ? addDays(d, -1) : d);
  const addBusinessDays = (s, n) => { let d = s, k = 0; while (dow(d) === 0 || dow(d) === 6) d = addDays(d, 1); while (k < n) { d = addDays(d, 1); const w = dow(d); if (w !== 0 && w !== 6) k++; } return d; };

  const countsOf = (data, itemId) =>
    data.counts.filter((c) => c.itemId === itemId).sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : 0));
  const receiptsBetween = (data, itemId, a, b) => // (a, b]
    data.receipts.filter((r) => r.itemId === itemId && r.date > a && r.date <= b).reduce((s, r) => s + Number(r.qty || 0), 0);

  // Intervalles entre deux relevés consécutifs
  function intervals(data, itemId) {
    const cs = countsOf(data, itemId);
    const out = [];
    for (let i = 0; i + 1 < cs.length; ) {
      const a = cs[i];
      // Si le stock monte sans réception saisie (livraison passée avant/après le comptage,
      // ou facture manquante), on fusionne avec l'intervalle suivant jusqu'à retrouver
      // une consommation positive. Sinon l'intervalle est ignoré.
      let j = i + 1, received, raw;
      for (;;) {
        received = receiptsBetween(data, itemId, sh(data, a.date), sh(data, cs[j].date));
        raw = +a.qty + received - +cs[j].qty;
        if (raw >= 0 || j + 1 >= cs.length) break;
        j++;
      }
      const b = cs[j];
      if (a.date !== b.date) out.push({
        from: a.date, to: b.date, startQty: +a.qty, endQty: +b.qty, received,
        consumption: Math.max(0, raw), valid: raw >= 0, merged: j - i - 1,
        s: sh(data, a.date), e: sh(data, b.date), open: openDays(data, sh(data, a.date), sh(data, b.date)),
      });
      i = j;
    }
    return out;
  }

  // Consommation sur la période [p1, p2] incluse
  function consumption(data, itemId, p1, p2) {
    const lo = addDays(p1, -1);
    let total = 0, covered = 0, unexplained = 0;
    for (const iv of intervals(data, itemId)) {
      if (!iv.valid) { if (iv.e >= p1 && iv.s <= p2) unexplained++; continue; }
      const a = iv.s > lo ? iv.s : lo;
      const b = iv.e < p2 ? iv.e : p2;
      if (b <= a || iv.open === 0) continue;
      const ov = openDays(data, a, b);
      total += (iv.consumption * ov) / iv.open;
      covered += ov;
    }
    const periodOpen = openDays(data, lo, p2);
    return {
      total, covered, periodOpen, unexplained,
      perDay: covered ? total / covered : null,
      coverage: periodOpen ? covered / periodOpen : 0,
      received: receiptsBetween(data, itemId, lo, p2),
    };
  }

  // ── Ventes (caisse) × recettes = consommation théorique ──
  const salesCache = new WeakMap();
  function salesIndex(data) {
    const sales = data.sales || [];
    if (salesCache.has(sales)) return salesCache.get(sales);
    const byDay = {}; let last = '';
    for (const r of sales) { (byDay[r.date] = byDay[r.date] || {})[r.dish] = ((byDay[r.date] || {})[r.dish] || 0) + Number(r.qty || 0); if (r.date > last) last = r.date; }
    const idx = { byDay, last };
    salesCache.set(sales, idx);
    return idx;
  }
  const recipesOf = (data, itemId) => (data.recipes || []).filter((r) => r.itemId === itemId && Number(r.qty) > 0);
  // Consommation théorique d'un article le jour d (null si pas de ventes ce jour-là)
  function theoUse(data, itemId, d) {
    const rec = recipesOf(data, itemId); if (!rec.length) return null;
    const day = salesIndex(data).byDay[d]; if (!day) return null;
    return rec.reduce((s, r) => s + (day[r.dish] || 0) * Number(r.qty), 0);
  }
  // Consommation théorique sur [p1, p2], limitée aux jours couverts par des inventaires (pour comparer au réel)
  function theoConsumption(data, itemId, p1, p2) {
    const ivs = intervals(data, itemId).filter((i) => i.valid);
    let total = 0, days = 0;
    for (let d = p1; d <= p2; d = addDays(d, 1)) {
      if (!ivs.some((i) => d > i.s && d <= i.e)) continue;
      const u = theoUse(data, itemId, d); if (u != null) { total += u; days++; }
    }
    return { total, days, perDay: days ? total / days : null };
  }
  // Recalage par les inventaires : conso réelle (inventaires + réceptions) ÷ conso théorique (ventes × recettes)
  // sur les mêmes jours. Corrige pertes, portions, recettes approximatives. Borné à [0,5 ; 2].
  function calibration(data, item, today) {
    const n = Math.max(56, Number(data.settings.historyDays) || 28);
    const p1 = addDays(today, -n + 1);
    const c = consumption(data, item.id, p1, today);
    const th = theoConsumption(data, item.id, p1, today);
    if (c.covered < 7 || th.days < 7 || !(th.total > 0) || !(c.total > 0)) return null;
    return Math.min(2, Math.max(0.5, c.total / th.total));
  }

  // Modèle de consommation : ventes réelles jusqu'à la veille, puis profil par jour de semaine
  function usageModel(data, item, today) {
    const base = dailyRateBase(data, item, today);
    const rec = recipesOf(data, item.id);
    if (Number(item.manualRate) > 0 || !rec.length) return base;
    const idx = salesIndex(data); if (!idx.last) return base;
    const k = calibration(data, item, today) || 1;
    const n = Math.max(28, Number(data.settings.historyDays) || 28);
    const sum = [0, 0, 0, 0, 0, 0, 0], cnt = [0, 0, 0, 0, 0, 0, 0];
    let tot = 0, days = 0;
    for (let d = addDays(idx.last, -n + 1); d <= idx.last; d = addDays(d, 1)) {
      const u = theoUse(data, item.id, d); if (u == null) continue;
      sum[dow(d)] += u; cnt[dow(d)]++; tot += u; days++;
    }
    if (!days) return base;
    const avg = tot / days;
    const profile = sum.map((x, i) => k * (cnt[i] ? x / cnt[i] : (isOpen(data, addDays('2026-01-04', i)) ? avg : 0)));
    const ks = Math.abs(k - 1) >= 0.005 ? ` · ×${String(Math.round(k * 100) / 100).replace('.', ',')} inv.` : '';
    return { rate: avg * k, source: `ventes ${days} j${ks}`, profile, salesLast: idx.last, theo: true, k };
  }
  function useOn(data, item, m, d) {
    if (m.theo && d <= m.salesLast) { const u = theoUse(data, item.id, d); if (u != null) return u * (m.k || 1); }
    if (m.profile) return m.profile[dow(d)];
    return isOpen(data, d) ? m.rate || 0 : 0;
  }
  const toModel = (r) => (r && typeof r === 'object' ? r : { rate: r });
  function useBetween(data, item, m, a, b) { // (a, b]
    let s = 0; for (let d = addDays(a, 1); d <= b; d = addDays(d, 1)) s += useOn(data, item, m, d); return s;
  }

  function dailyRate(data, item, today) { return usageModel(data, item, today); }
  function dailyRateBase(data, item, today) {
    if (Number(item.manualRate) > 0) return { rate: Number(item.manualRate), source: 'manuel' };
    const n = Number(data.settings.historyDays) || 28;
    const c = consumption(data, item.id, addDays(today, -n + 1), today);
    if (c.perDay != null) return { rate: c.perDay, source: `moy. ${c.covered} j` };
    // pas assez d'historique récent : on prend tout l'historique
    const all = intervals(data, item.id).filter((i) => i.valid);
    const open = all.reduce((s, i) => s + i.open, 0);
    if (open) return { rate: all.reduce((s, i) => s + i.consumption, 0) / open, source: 'historique' };
    return { rate: null, source: 'pas de données' };
  }

  const pendingOrders = (data) => data.orders.filter((o) => o.status === 'pending');
  // Quantités en commande pour un article, livraison effective dans (a, b]
  function pendingBetween(data, itemId, a, b, today) {
    let q = 0;
    for (const o of pendingOrders(data)) {
      const d = o.deliveryDate < today ? today : o.deliveryDate;
      if (d > a && d <= b) for (const l of o.lines) if (l.itemId === itemId) q += Number(l.qty || 0);
    }
    return q;
  }

  function lastCount(data, itemId, upTo) {
    const cs = countsOf(data, itemId).filter((c) => c.date <= upTo);
    return cs.length ? cs[cs.length - 1] : null;
  }

  // Stock estimé en fin de journée `date`
  function stockAt(data, item, date, rate, today) {
    const lc = lastCount(data, item.id, today);
    if (!lc) return null;
    const base = sh(data, lc.date);
    if (date <= base) return +lc.qty;
    return +lc.qty + receiptsBetween(data, item.id, base, date) +
      pendingBetween(data, item.id, base, date, today) - useBetween(data, item, toModel(rate), base, date);
  }

  function ruptureDate(data, item, rate, today, horizon = 120) {
    if (!toModel(rate).rate) return null;
    const lc = lastCount(data, item.id, today);
    if (!lc) return null;
    const start = lc.date < today ? lc.date : today;
    for (let i = 0, d = start; i <= horizon + diffDays(start, today); i++, d = addDays(d, 1)) {
      if (stockAt(data, item, d, rate, today) <= 0.0001) return d;
    }
    return null;
  }

  // Prochain jour de commande possible (si aucun jour défini : prochain jour d'ouverture)
  function nextOrderDay(sup, from, data) {
    const days = (sup && sup.orderDays) || [];
    if (!days.length) {
      for (let i = 0; i < 7; i++) { const d = addDays(from, i); if (!data || isOpen(data, d)) return d; }
      return from;
    }
    for (let i = 0; i < 14; i++) { const d = addDays(from, i); if (days.includes(dow(d))) return d; }
    return from;
  }

  const isAsNeeded = (sup) => !!(sup && sup.mode === 'asNeeded');
  const DEFAULT_COVER_AS_NEEDED = 14;
  // Date de livraison pour une commande passée le jour d
  const leadDate = (sup, d) => {
    const lead = Number(sup ? sup.leadDays : 1) || 0;
    return sup && sup.leadBusiness ? addBusinessDays(d, lead) : addDays(d, lead);
  };
  const safetyOf = (data, item) => (item.safetyDays !== '' && item.safetyDays != null ? Number(item.safetyDays) : Number(data.settings.safetyDays || 0));
  // Seuil sous lequel le stock ne doit pas descendre : stock minimum ou N jours de conso
  const floorOf = (data, item, rate) => Math.max(Number(item.minStock) > 0 ? Number(item.minStock) : 0, (rate || 0) * safetyOf(data, item));

  // Premier jour (à partir d'aujourd'hui) où le stock théorique de fin de journée passe sous le seuil
  function thresholdDate(data, item, model, today, floor, horizon = 120) {
    if (!model.rate) return null;
    if (!lastCount(data, item.id, today)) return null;
    let s = stockAt(data, item, today, model, today);
    if (s < floor - 1e-6) return today;
    for (let i = 1, d = addDays(today, 1); i <= horizon; i++, d = addDays(d, 1)) {
      const p = addDays(d, -1);
      s += receiptsBetween(data, item.id, p, d) + pendingBetween(data, item.id, p, d, today) - useOn(data, item, model, d);
      if (s < floor - 1e-6) return d;
    }
    return null;
  }
  // Dernier jour de commande possible pour être livré au plus tard le jour `limit`
  function latestOrderDay(data, sup, limit, today) {
    let O = nextOrderDay(sup, today, data);
    if (leadDate(sup, O) > limit) return { date: O, late: true };
    for (let i = 0; i < 200; i++) {
      const nx = nextOrderDay(sup, addDays(O, 1), data);
      if (nx <= O || leadDate(sup, nx) > limit) break;
      O = nx;
    }
    return { date: O, late: false };
  }

  // Suggestions pour toutes les références actives.
  // Fournisseur « quand nécessaire » : une seule commande groupée, au jour où la PREMIÈRE référence
  // du fournisseur passerait sous son seuil de sécurité (stock théorique recalé sur le dernier inventaire).
  function suggestAll(data, today) {
    const items = data.items.filter((i) => i.active !== false);
    const out = [], groups = {};
    for (const it of items) {
      const sup = data.suppliers.find((s) => s.id === it.supplierId);
      if (isAsNeeded(sup)) (groups[sup.id] = groups[sup.id] || { sup, list: [] }).list.push(it);
      else out.push(suggest(data, it, today));
    }
    for (const { sup, list } of Object.values(groups)) {
      let best = null;
      for (const it of list) {
        const m = usageModel(data, it, today);
        if (!m.rate) continue;
        const R = thresholdDate(data, it, m, today, floorOf(data, it, m.rate));
        if (!R) continue;
        const o = latestOrderDay(data, sup, R, today);
        if (!best || o.date < best.date || (o.date === best.date && R < best.limit)) best = { ...o, limit: R, item: it };
      }
      const plan = best ? { orderDate: best.date, late: best.late, limitDate: best.limit, driver: best.item } : { orderDate: null };
      for (const it of list) out.push(suggest(data, it, today, plan));
    }
    return out;
  }

  function suggest(data, item, today, plan) {
    const sup = data.suppliers.find((s) => s.id === item.supplierId) || null;
    const asNeeded = isAsNeeded(sup);
    const model = usageModel(data, item, today);
    const { rate, source } = model;
    const lc = lastCount(data, item.id, today);
    const res = { item, supplier: sup, rate, rateSource: source, lastCount: lc, asNeeded };
    if (!lc) return { ...res, status: 'nocount' };
    const stockNow = stockAt(data, item, today, model, today);
    if (asNeeded && !plan) return suggestAll(data, today).find((s) => s.item.id === item.id);
    const lt = (d) => leadDate(sup, d);
    const floor0 = floorOf(data, item, rate);
    if (asNeeded) {
      Object.assign(res, { plan, floor: floor0, limitDate: rate ? thresholdDate(data, item, model, today, floor0) : null });
      if (!plan.orderDate) return { ...res, stockNow, orderDate: null, deliveryDate: null, qty: 0, status: rate == null ? 'norate' : 'ok', daysLeft: rate > 0 ? Math.max(0, stockNow) / rate : null };
    }
    const O = asNeeded ? (plan.orderDate < today ? today : plan.orderDate) : nextOrderDay(sup, today, data);
    const D = lt(O);
    const O2 = nextOrderDay(sup, addDays(O, 1), data);
    const D2 = lt(O2);
    if (rate == null) return { ...res, stockNow, orderDate: O, deliveryDate: D, status: 'norate' };
    const safetyDays = safetyOf(data, item);
    const stockBefore = stockAt(data, item, addDays(D, -1), model, today);
    // Déclenchement : le stock ne tiendra pas jusqu'à la prochaine livraison possible (+ sécurité)
    const nextUse = useBetween(data, item, model, addDays(D, -1), addDays(D2, -1));
    const inNext = pendingBetween(data, item.id, addDays(D, -1), addDays(D2, -1), today);
    // stock minimum à maintenir (ex. stock de sécurité d'un produit fait maison)
    const floor = floor0;
    // « Quand nécessaire » : la commande groupée complète toutes les références du fournisseur
    const trigger = asNeeded || nextUse + floor - Math.max(0, stockBefore) - inNext > 0;
    // Couverture visée : jusqu'à la livraison suivante, ou N jours si le fournisseur a une couverture définie
    const coverEnd = Number(sup && sup.coverDays) > 0 ? addDays(D, Number(sup.coverDays)) : asNeeded ? addDays(D, DEFAULT_COVER_AS_NEEDED) : D2;
    const inWindow = pendingBetween(data, item.id, addDays(D, -1), addDays(coverEnd, -1), today);
    const coverOpen = openDays(data, addDays(D, -1), addDays(coverEnd, -1));
    const coverUse = useBetween(data, item, model, addDays(D, -1), addDays(coverEnd, -1));
    const need = coverUse + floor - Math.max(0, stockBefore) - inWindow;
    const pack = Number(item.packSize) > 0 ? Number(item.packSize) : 1;
    let qty = trigger && need > 0 ? Math.ceil(need / pack - 1e-9) * pack : 0;
    if (qty > 0 && Number(item.minOrder) > qty) qty = Math.ceil(Number(item.minOrder) / pack) * pack;
    const rup = ruptureDate(data, item, model, today);
    let status = 'ok';
    if (qty > 0) status = O === today ? 'today' : 'later';
    if (rup && rup < D) status = 'risk';
    return {
      ...res, stockNow, orderDate: O, deliveryDate: D, nextDelivery: coverEnd, coverOpen, safetyDays,
      stockAtDelivery: stockBefore, pendingInWindow: inWindow, need, qty, ruptureDate: rup, status,
      daysLeft: rate > 0 ? Math.max(0, stockNow) / rate : null,
    };
  }

  const api = { suggestAll, thresholdDate, calibration, isAsNeeded, theoConsumption, theoUse, salesIndex, usageModel, addBusinessDays, addDays, diffDays, dow, todayStr, isOpen, openDays, intervals, consumption, dailyRate, stockAt, ruptureDate, nextOrderDay, suggest, lastCount };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.Engine = api;
})(typeof window !== 'undefined' ? window : globalThis);
