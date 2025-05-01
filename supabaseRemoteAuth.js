const { RemoteAuth } = require('whatsapp-web.js');
const SupabaseStore = require('./supabaseStore');

class SupabaseRemoteAuth extends RemoteAuth {
  constructor(clientId, supabase) {
    const store = new SupabaseStore(supabase, clientId);
    super(client, store, {
      clientId,
      backupSyncIntervalMs: 300000, // 5 minutos
      dataPath: null // Deshabilitamos el uso de archivos locales
    });
  }
}

module.exports = SupabaseRemoteAuth;
