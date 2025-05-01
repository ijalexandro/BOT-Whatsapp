const { RemoteAuth } = require('whatsapp-web.js');
const SupabaseStore = require('./supabaseStore');

class SupabaseRemoteAuth extends RemoteAuth {
  constructor(clientId, supabase) {
    const store = new SupabaseStore(supabase, clientId);
    super({
      clientId: clientId,
      backupSyncIntervalMs: 60000, // Intervalo mínimo de 1 minuto
      store: store, // Pasamos el store personalizado
    });
  }
}

module.exports = SupabaseRemoteAuth;
