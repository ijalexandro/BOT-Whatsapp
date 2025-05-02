const { RemoteAuth } = require('whatsapp-web.js');
const SupabaseStore = require('./supabaseStore');

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

  // Método setup requerido por whatsapp-web.js
  setup(client) {
    this.client = client;
    return super.setup(client); // Llama al setup de RemoteAuth
  }
}

module.exports = SupabaseRemoteAuth;
