class SupabaseRemoteAuth extends RemoteAuth {
  constructor(options) {
    const { clientId, supabase } = options || {};
    if (!clientId || !supabase) {
      throw new Error('clientId y supabase son requeridos para SupabaseRemoteAuth');
    }
    const store = new SupabaseStore(supabase, clientId);

    super({
      clientId,
      store,
      // desactivo el ZIP de backup en disco
      backupSync: false,
      // opcionalmente, no programo ningún interval de backup
      backupSyncIntervalMs: 0,
      dataPath: undefined
    });

    this.dataPath = undefined;
    this.sessionName = `RemoteAuth-${clientId}`;
    console.log('✅ SupabaseRemoteAuth configurado para clientId:', clientId);
  }

  setup(client) {
    this.client = client;
    if (typeof super.setup === 'function') {
      super.setup(client);
    }
    console.log(`🔧 setup() ejecutado para clientId: ${this.clientId}`);
  }
}

module.exports = SupabaseRemoteAuth;
