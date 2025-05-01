const { RemoteAuth } = require('whatsapp-web.js');
const SupabaseStore = require('./supabaseStore');

class SupabaseRemoteAuth extends RemoteAuth {
  constructor(client, { clientId, supabase }) {
    const store = new SupabaseStore(supabase, clientId);
    // Pasamos las opciones esperadas por RemoteAuth
    super(client, {
      clientId,
      store,
      backupSyncIntervalMs: 300000, // 5 minutos
      dataPath: null // Deshabilitamos el uso de archivos locales
    });
  }
}

module.exports = SupabaseRemoteAuth;
