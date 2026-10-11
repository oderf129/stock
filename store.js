/* Stockage des données : cache local + synchronisation OneDrive (Microsoft Graph). */
(function () {
  const CACHE_KEY = 'stockapp.data';
  const SCOPES = ['Files.ReadWrite.AppFolder', 'User.Read'];
  const GRAPH = 'https://graph.microsoft.com/v1.0';
  const cfg = window.APP_CONFIG || {};

  const Store = {
    mode: cfg.clientId ? 'onedrive' : 'local',
    account: null,
    eTag: null,
    status: 'idle', // idle | loading | saving | saved | error | offline
    onStatus: () => {},
    msal: null,

    readCache() {
      try { const s = localStorage.getItem(CACHE_KEY); return s ? JSON.parse(s) : null; } catch { return null; }
    },
    writeCache(data) {
      try { localStorage.setItem(CACHE_KEY, JSON.stringify(data)); } catch {}
    },
    setStatus(s, msg) { this.status = s; this.onStatus(s, msg); },

    async init() {
      if (this.mode !== 'onedrive') return;
      if (!window.msal) { this.mode = 'local'; return; }
      this.msal = new msal.PublicClientApplication({
        auth: {
          clientId: cfg.clientId,
          authority: 'https://login.microsoftonline.com/' + (cfg.authority || 'consumers'),
          redirectUri: location.origin + location.pathname,
        },
        cache: { cacheLocation: 'localStorage' },
      });
      await this.msal.initialize();
      const r = await this.msal.handleRedirectPromise().catch((e) => { console.error(e); return null; });
      if (r && r.account) this.msal.setActiveAccount(r.account);
      this.account = this.msal.getActiveAccount() || this.msal.getAllAccounts()[0] || null;
      if (this.account) this.msal.setActiveAccount(this.account);
    },
    login() { return this.msal.loginRedirect({ scopes: SCOPES }); },
    logout() { return this.msal.logoutRedirect({ account: this.account }); },

    async token() {
      try {
        const r = await this.msal.acquireTokenSilent({ scopes: SCOPES, account: this.account });
        return r.accessToken;
      } catch (e) {
        await this.msal.acquireTokenRedirect({ scopes: SCOPES, account: this.account });
        throw e;
      }
    },
    path() { return `${GRAPH}/me/drive/special/approot:/${encodeURIComponent(cfg.fileName || 'Stock MLW.xlsx')}`; },
    isXlsx() { return /\.xlsx$/i.test(cfg.fileName || 'Stock MLW.xlsx'); },
    // Données -> fichier (Excel ou JSON)
    encode(data) {
      if (!this.isXlsx()) return { body: JSON.stringify(data, null, 1), type: 'application/json' };
      const wb = XlsxIO.toWorkbook(XLSX, data, window.Engine);
      return { body: XLSX.write(wb, { type: 'array', bookType: 'xlsx' }), type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
    },
    async decode(res) {
      if (!this.isXlsx()) return res.json();
      return XlsxIO.fromWorkbook(XLSX, XLSX.read(await res.arrayBuffer(), { type: 'array', cellDates: true }));
    },

    // Charge depuis OneDrive. Retourne null si le fichier n'existe pas encore.
    async loadRemote() {
      this.setStatus('loading');
      const t = await this.token();
      const meta = await fetch(this.path(), { headers: { Authorization: 'Bearer ' + t } });
      if (meta.status === 404) { this.eTag = null; this.setStatus('saved'); return null; }
      if (!meta.ok) throw new Error('OneDrive ' + meta.status);
      const m = await meta.json();
      this.eTag = m.eTag;
      const res = await fetch(m['@microsoft.graph.downloadUrl']);
      const data = await this.decode(res);
      this.writeCache(data);
      this.setStatus('saved');
      return data;
    },

    async saveRemote(data) {
      const t = await this.token();
      const f = this.encode(data);
      const headers = { Authorization: 'Bearer ' + t, 'Content-Type': f.type };
      if (this.eTag) headers['If-Match'] = this.eTag;
      const res = await fetch(this.path() + ':/content', { method: 'PUT', headers, body: f.body });
      if (res.status === 412) { const e = new Error('conflict'); e.conflict = true; throw e; }
      if (res.status === 423) { const e = new Error('locked'); e.locked = true; throw e; }
      if (!res.ok) throw new Error('OneDrive ' + res.status);
      this.eTag = (await res.json()).eTag;
    },

    _timer: null,
    save(data) {
      data.updatedAt = new Date().toISOString();
      this.writeCache(data);
      if (this.mode !== 'onedrive' || !this.account) { this.setStatus('saved'); return; }
      this.setStatus('saving');
      clearTimeout(this._timer);
      this._timer = setTimeout(async () => {
        try { await this.saveRemote(data); this.setStatus('saved'); }
        catch (e) {
          console.error(e);
          if (e.conflict) this.setStatus('error', 'Le fichier Excel a été modifié ailleurs (Excel ou un autre appareil). Recharge la page pour récupérer la dernière version, puis refais ta dernière saisie.');
          else if (e.locked) { this.setStatus('error', 'Le fichier Excel est ouvert en modification dans Excel. Ferme-le : la sauvegarde sera retentée dans 1 minute.'); setTimeout(() => this.save(data), 60000); }
          else this.setStatus('error', navigator.onLine ? 'Échec de la sauvegarde OneDrive : ' + e.message : 'Hors ligne — sauvegardé sur cet appareil, synchro au prochain enregistrement.');
        }
      }, 800);
    },
  };
  window.Store = Store;
})();
