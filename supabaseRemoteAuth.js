const { RemoteAuth } = require('whatsapp-web.js');
const SupabaseStore = require('./supabaseStore');

class SupabaseRemoteAuth extends RemoteAuth {
  constructor(client) {
    const clientId = 'my-client'; // Hardcodeamos el clientId
    const supabase = require('./supabaseClient'); // Importamos supabase
    const store = new SupabaseStore(supabase, clientId);
    super(client, {
      clientId: clientId,
      store: store,
      backupSyncIntervalMs: 300000, // 5 minutos
      dataPath: null // Sin archivos locales
    });
  }
}

module.exports = SupabaseRemoteAuth;
