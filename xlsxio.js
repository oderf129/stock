/* Conversion données de l'app <-> classeur Excel (SheetJS).
 * Le classeur est la sauvegarde de référence sur OneDrive : il reste lisible et modifiable dans Excel.
 * Onglets lus : Inventaires, Réceptions, Commandes, Références, Fournisseurs, Réglages.
 * Onglet « Synthèse » : régénéré à chaque enregistrement (lecture seule). */
(function (root) {
  const DOW = ['dim', 'lun', 'mar', 'mer', 'jeu', 'ven', 'sam'];
  const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
  const pad = (x) => String(x).padStart(2, '0');

  // 'AAAA-MM-JJ' -> Date locale (cellule date Excel)
  const toXDate = (s) => (s ? new Date(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10), 12) : '');
  // cellule (Date, nombre série Excel ou texte JJ/MM/AAAA ou AAAA-MM-JJ) -> 'AAAA-MM-JJ'
  function fromXDate(v) {
    if (v == null || v === '') return '';
    if (v instanceof Date) { const d = new Date(v.getTime() + 6 * 3600e3); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
    if (typeof v === 'number') { const d = new Date(Math.round((v - 25569) * 864e5)); return d.toISOString().slice(0, 10); }
    const s = String(v).trim();
    let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/); if (m) return `${m[1]}-${pad(m[2])}-${pad(m[3])}`;
    m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})/); if (m) return `${m[3].length === 2 ? '20' + m[3] : m[3]}-${pad(m[2])}-${pad(m[1])}`;
    return '';
  }
  const num = (v) => (v === '' || v == null ? '' : Number(String(v).replace(',', '.')));
  const yes = (v) => /^(oui|o|yes|y|1|vrai|true)$/i.test(String(v ?? '').trim());
  const days = (arr) => (arr || []).map((d) => DOW[d]).join(', ');
  const parseDays = (v) => String(v ?? '').toLowerCase().split(/[,; ]+/).map((x) => DOW.indexOf(x.slice(0, 3))).filter((x) => x >= 0);

  function sheet(XLSX, header, rows, widths) {
    const ws = XLSX.utils.aoa_to_sheet([header, ...rows], { cellDates: true, dateNF: 'dd/mm/yyyy' });
    ws['!cols'] = (widths || header.map(() => 14)).map((w) => ({ wch: w }));
    // format date français
    for (const k of Object.keys(ws)) if (ws[k] && ws[k].t === 'd') ws[k].z = 'dd/mm/yyyy';
    return ws;
  }

  function toWorkbook(XLSX, data, Engine) {
    const items = Object.fromEntries(data.items.map((i) => [i.id, i]));
    const nm = (id) => (items[id] || {}).name || id;
    const un = (id) => (items[id] || {}).unit || '';
    const pk = (id) => Number((items[id] || {}).packSize) > 1 ? Number(items[id].packSize) : 1;
    const byDate = (a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : nm(a.itemId).localeCompare(nm(b.itemId)));
    const wb = XLSX.utils.book_new();

    // Synthèse (calculée)
    if (Engine) {
      const t = Engine.todayStr();
      const all = Engine.suggestAll(data, t);
      const rows = data.items.filter((i) => i.active !== false).map((i) => {
        const s = all.find((x) => x.item.id === i.id);
        const sup = data.suppliers.find((x) => x.id === i.supplierId);
        return [i.name, sup ? sup.name : '', i.unit, s.lastCount ? toXDate(s.lastCount.date) : '', s.lastCount ? +s.lastCount.qty : '',
          s.stockNow != null ? Math.round(Math.max(0, s.stockNow) * 10) / 10 : '', s.rate != null ? Math.round(s.rate * 10) / 10 : '',
          s.ruptureDate ? toXDate(s.ruptureDate) : '', s.orderDate ? toXDate(s.orderDate) : '', s.deliveryDate ? toXDate(s.deliveryDate) : '',
          s.qty != null ? s.qty / pk(i.id) : ''];
      });
      const ws = sheet(XLSX, ['Référence', 'Fournisseur', 'Unité', 'Dernier inventaire', 'Qté inventaire', 'Stock estimé', 'Conso / jour', 'Rupture prévue', 'Prochaine commande', 'Livraison', 'Cartons conseillés'],
        rows, [30, 22, 8, 16, 14, 13, 12, 15, 18, 12, 17]);
      XLSX.utils.sheet_add_aoa(ws, [[`Calculé le ${new Date().toLocaleString('fr-FR')} — onglet recalculé par l'app, ne pas modifier`]], { origin: { r: rows.length + 2, c: 0 } });
      XLSX.utils.book_append_sheet(wb, ws, 'Synthèse');
    }

    XLSX.utils.book_append_sheet(wb, sheet(XLSX, ['Date', 'Code', 'Référence', 'Quantité', 'Unité'],
      [...data.counts].sort(byDate).map((c) => [toXDate(c.date), c.itemId, nm(c.itemId), +c.qty, un(c.itemId)]), [12, 12, 30, 10, 8]), 'Inventaires');

    XLSX.utils.book_append_sheet(wb, sheet(XLSX, ['Date', 'Code', 'Référence', 'Quantité', 'Unité', 'Cartons', 'N° commande', 'Note'],
      [...data.receipts].sort(byDate).map((r) => [toXDate(r.date), r.itemId, nm(r.itemId), +r.qty, un(r.itemId), Math.round((r.qty / pk(r.itemId)) * 100) / 100, r.orderId || '', r.note || '']),
      [12, 12, 30, 10, 8, 9, 13, 40]), 'Réceptions');

    const orows = [];
    for (const o of [...data.orders].sort((a, b) => (a.orderDate < b.orderDate ? -1 : 1)))
      for (const l of o.lines) orows.push([o.id, o.supplierId || '', toXDate(o.orderDate), toXDate(o.deliveryDate), o.status === 'pending' ? 'En attente' : 'Reçue', l.itemId, nm(l.itemId), Math.round((l.qty / pk(l.itemId)) * 100) / 100, +l.qty, un(l.itemId)]);
    XLSX.utils.book_append_sheet(wb, sheet(XLSX, ['N° commande', 'Code fournisseur', 'Date commande', 'Livraison prévue', 'Statut', 'Code', 'Référence', 'Cartons', 'Quantité', 'Unité'], orows,
      [13, 15, 14, 15, 11, 12, 30, 9, 10, 8]), 'Commandes');

    XLSX.utils.book_append_sheet(wb, sheet(XLSX, ['Code', 'Nom', 'Unité de comptage', 'Code fournisseur', 'Unités par carton', 'Nom du lot', 'Stock sécurité (j)', 'Commande min', 'Conso manuelle / j', 'Active', 'Stock minimum'],
      data.items.map((i) => [i.id, i.name, i.unit, i.supplierId || '', +i.packSize || 1, i.packLabel || 'carton', i.safetyDays ?? '', i.minOrder ?? '', i.manualRate ?? '', i.active === false ? 'Non' : 'Oui', i.minStock ?? '']),
      [12, 30, 16, 15, 15, 10, 16, 13, 17, 7, 14]), 'Références');

    XLSX.utils.book_append_sheet(wb, sheet(XLSX, ['Plat', 'Code', 'Produit', 'Quantité par plat'],
      (data.recipes || []).map((r) => [r.dish, r.itemId, nm(r.itemId), +r.qty]), [34, 12, 30, 16]), 'Recettes');

    XLSX.utils.book_append_sheet(wb, sheet(XLSX, ['Date', 'Plat', 'Quantité'],
      [...(data.sales || [])].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : b.qty - a.qty)).map((r) => [toXDate(r.date), r.dish, +r.qty]), [12, 40, 10]), 'Ventes');

    XLSX.utils.book_append_sheet(wb, sheet(XLSX, ['Code', 'Nom', 'Jours de commande', 'Délai (j)', 'Jours ouvrés', 'Couverture (j)', 'Notes', 'Type de commande'],
      data.suppliers.map((s) => [s.id, s.name, days(s.orderDays) || 'tous', +s.leadDays || 0, s.leadBusiness ? 'Oui' : 'Non', s.coverDays ?? '', s.notes || '', s.mode === 'asNeeded' ? 'Quand nécessaire' : 'Jours fixes']),
      [14, 24, 20, 9, 12, 14, 60, 18]), 'Fournisseurs');

    const st = data.settings || {};
    XLSX.utils.book_append_sheet(wb, sheet(XLSX, ['Paramètre', 'Valeur'], [
      ['Jours de fermeture', days(st.closedDays)],
      ['Historique moyenne (j)', st.historyDays ?? 28],
      ['Stock sécurité par défaut (j)', st.safetyDays ?? 1],
      ['Inventaire fait', st.countTiming === 'morning' ? 'matin' : 'soir'],
      ['Dernière modification', data.updatedAt || ''],
    ], [30, 30]), 'Réglages');
    return wb;
  }

  function rowsOf(XLSX, wb, name) {
    const ws = wb.Sheets[name];
    if (!ws) return [];
    return XLSX.utils.sheet_to_json(ws, { defval: '', raw: true });
  }

  function fromWorkbook(XLSX, wb) {
    const data = { version: 1, settings: {}, suppliers: [], items: [], counts: [], receipts: [], orders: [], recipes: [], sales: [] };
    for (const r of rowsOf(XLSX, wb, 'Fournisseurs')) {
      if (!r['Code'] && !r['Nom']) continue;
      const od = String(r['Jours de commande'] || '').toLowerCase().startsWith('tous') ? [] : parseDays(r['Jours de commande']);
      data.suppliers.push({ id: String(r['Code'] || uid()), name: String(r['Nom'] || r['Code']), orderDays: od, leadDays: num(r['Délai (j)']) || 0,
        leadBusiness: yes(r['Jours ouvrés']), coverDays: num(r['Couverture (j)']), notes: String(r['Notes'] || ''),
        mode: /n[ée]cessaire|besoin/i.test(String(r['Type de commande'] || '')) ? 'asNeeded' : 'fixed' });
    }
    for (const r of rowsOf(XLSX, wb, 'Références')) {
      if (!r['Code'] && !r['Nom']) continue;
      data.items.push({ id: String(r['Code'] || uid()), name: String(r['Nom'] || r['Code']), unit: String(r['Unité de comptage'] || ''),
        supplierId: String(r['Code fournisseur'] || '') || null, packSize: num(r['Unités par carton']) || 1, packLabel: String(r['Nom du lot'] || 'carton'),
        safetyDays: num(r['Stock sécurité (j)']), minOrder: num(r['Commande min']), manualRate: num(r['Conso manuelle / j']),
        active: r['Active'] === '' ? true : yes(r['Active']), minStock: num(r['Stock minimum']) });
    }
    const byName = Object.fromEntries(data.items.map((i) => [i.name.toLowerCase(), i.id]));
    const ref = (r) => { const c = String(r['Code'] || ''); if (c && data.items.some((i) => i.id === c)) return c; return byName[String(r['Référence'] || '').toLowerCase()] || null; };
    for (const r of rowsOf(XLSX, wb, 'Inventaires')) {
      const d = fromXDate(r['Date']), id = ref(r);
      if (d && id && r['Quantité'] !== '') data.counts.push({ id: uid(), date: d, itemId: id, qty: num(r['Quantité']) });
    }
    for (const r of rowsOf(XLSX, wb, 'Réceptions')) {
      const d = fromXDate(r['Date']), id = ref(r);
      if (!d || !id) continue;
      const pack = (data.items.find((i) => i.id === id) || {}).packSize || 1;
      const q = r['Quantité'] !== '' ? num(r['Quantité']) : num(r['Cartons']) * pack;
      if (q > 0) data.receipts.push({ id: uid(), date: d, itemId: id, qty: q, orderId: String(r['N° commande'] || '') || undefined, note: String(r['Note'] || '') });
    }
    const orders = {};
    for (const r of rowsOf(XLSX, wb, 'Commandes')) {
      const no = String(r['N° commande'] || ''), id = ref(r);
      if (!no || !id) continue;
      const pack = (data.items.find((i) => i.id === id) || {}).packSize || 1;
      const o = (orders[no] = orders[no] || { id: no, supplierId: String(r['Code fournisseur'] || '') || null, orderDate: fromXDate(r['Date commande']),
        deliveryDate: fromXDate(r['Livraison prévue']), status: /attente/i.test(r['Statut']) ? 'pending' : 'received', lines: [] });
      const q = r['Quantité'] !== '' ? num(r['Quantité']) : num(r['Cartons']) * pack;
      o.lines.push({ itemId: id, qty: q });
    }
    data.orders = Object.values(orders);
    data.recipes = rowsOf(XLSX, wb, 'Recettes').filter((r) => r['Plat'] && ref(r)).map((r) => ({ dish: String(r['Plat']).trim(), itemId: ref(r), qty: num(r['Quantité par plat']) || 1 }));
    data.sales = rowsOf(XLSX, wb, 'Ventes').map((r) => ({ date: fromXDate(r['Date']), dish: String(r['Plat'] || '').trim(), qty: num(r['Quantité']) })).filter((r) => r.date && r.dish && r.qty);
    const set = Object.fromEntries(rowsOf(XLSX, wb, 'Réglages').map((r) => [r['Paramètre'], r['Valeur']]));
    data.settings = {
      closedDays: parseDays(set['Jours de fermeture']),
      historyDays: num(set['Historique moyenne (j)']) || 28,
      safetyDays: num(set['Stock sécurité par défaut (j)']) === '' ? 1 : num(set['Stock sécurité par défaut (j)']),
      countTiming: /matin/i.test(set['Inventaire fait'] || '') ? 'morning' : 'end',
    };
    if (set['Dernière modification']) data.updatedAt = String(set['Dernière modification']);
    return data;
  }

  const api = { toWorkbook, fromWorkbook, fromXDate };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.XlsxIO = api;
})(typeof window !== 'undefined' ? window : globalThis);
