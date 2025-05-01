const { RemoteAuth } = require('whatsapp-web.js');
const SupabaseStore = require('./supabaseStore');

class SupabaseRemoteAuth extends RemoteAuth {
  constructor(clientId, supabase) {
    const store = new SupabaseStore(supabase, clientId);
    super(client, store, {
      clientId,
      backupSyncIntervalMs: 300000, // 5 minutos
      // Deshabilitamos el respaldo local
      dataPath: null // Esto debería evitar que RemoteAuth intente usar un archivo local
    });
  }
}

module.exports = SupabaseRemoteAuth;
