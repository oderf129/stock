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

  function dailyRate(data, item, today) {
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
      pendingBetween(data, item.id, base, date, today) - (rate || 0) * openDays(data, base, date);
  }

  function ruptureDate(data, item, rate, today, horizon = 120) {
    if (!rate) return null;
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

  function suggest(data, item, today) {
    const sup = data.suppliers.find((s) => s.id === item.supplierId) || null;
    const lead = Number(sup ? sup.leadDays : 1) || 0;
    const { rate, source } = dailyRate(data, item, today);
    const lc = lastCount(data, item.id, today);
    const res = { item, supplier: sup, rate, rateSource: source, lastCount: lc };
    if (!lc) return { ...res, status: 'nocount' };
    const stockNow = stockAt(data, item, today, rate, today);
    const O = nextOrderDay(sup, today, data);
    const lt = (d) => (sup && sup.leadBusiness ? addBusinessDays(d, lead) : addDays(d, lead));
    const D = lt(O);
    const O2 = nextOrderDay(sup, addDays(O, 1), data);
    const D2 = lt(O2);
    if (rate == null) return { ...res, stockNow, orderDate: O, deliveryDate: D, status: 'norate' };
    const safetyDays = item.safetyDays !== '' && item.safetyDays != null ? Number(item.safetyDays) : Number(data.settings.safetyDays || 0);
    const stockBefore = stockAt(data, item, addDays(D, -1), rate, today);
    // Déclenchement : le stock ne tiendra pas jusqu'à la prochaine livraison possible (+ sécurité)
    const nextOpen = openDays(data, addDays(D, -1), addDays(D2, -1));
    const inNext = pendingBetween(data, item.id, addDays(D, -1), addDays(D2, -1), today);
    const trigger = rate * (nextOpen + safetyDays) - Math.max(0, stockBefore) - inNext > 0;
    // Couverture visée : jusqu'à la livraison suivante, ou N jours si le fournisseur a une couverture définie
    const coverEnd = Number(sup && sup.coverDays) > 0 ? addDays(D, Number(sup.coverDays)) : D2;
    const inWindow = pendingBetween(data, item.id, addDays(D, -1), addDays(coverEnd, -1), today);
    const coverOpen = openDays(data, addDays(D, -1), addDays(coverEnd, -1));
    const need = rate * (coverOpen + safetyDays) - Math.max(0, stockBefore) - inWindow;
    const pack = Number(item.packSize) > 0 ? Number(item.packSize) : 1;
    let qty = trigger && need > 0 ? Math.ceil(need / pack - 1e-9) * pack : 0;
    if (qty > 0 && Number(item.minOrder) > qty) qty = Math.ceil(Number(item.minOrder) / pack) * pack;
    const rup = ruptureDate(data, item, rate, today);
    let status = 'ok';
    if (qty > 0) status = O === today ? 'today' : 'later';
    if (rup && rup < D) status = 'risk';
    return {
      ...res, stockNow, orderDate: O, deliveryDate: D, nextDelivery: coverEnd, coverOpen, safetyDays,
      stockAtDelivery: stockBefore, pendingInWindow: inWindow, need, qty, ruptureDate: rup, status,
      daysLeft: rate > 0 ? Math.max(0, stockNow) / rate : null,
    };
  }

  const api = { addBusinessDays, addDays, diffDays, dow, todayStr, isOpen, openDays, intervals, consumption, dailyRate, stockAt, ruptureDate, nextOrderDay, suggest, lastCount };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.Engine = api;
})(typeof window !== 'undefined' ? window : globalThis);
