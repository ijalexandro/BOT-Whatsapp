class SupabaseRemoteAuth extends RemoteAuth {
  constructor(client, options) {
    const { clientId, supabase } = options || {};
    if (!clientId || !supabase) {
      throw new Error('clientId y supabase son requeridos para SupabaseRemoteAuth');
    }
    const store = new SupabaseStore(supabase, clientId);
    super(client, {
      clientId,
      store,
      backupSyncIntervalMs: 300000, // 5 minutos
      dataPath: null // Sin archivos locales
    });
  }
}
