const { RemoteAuth } = require('whatsapp-web.js');
const SupabaseStore = require('./supabaseStore');

class SupabaseRemoteAuth extends RemoteAuth {
  constructor(options) {
    const { clientId, supabase } = options || {};
    if (!clientId || !supabase) {
      throw new Error('clientId y supabase son requeridos para SupabaseRemoteAuth');
    }
    const store = new SupabaseStore(supabase, clientId);
    super(null, {
      clientId,
      store,
      backupSyncIntervalMs: 300000, // 5 minutos
      dataPath: null // Sin archivos locales
    });
    this.options = options;
  }

  setup(client) {
    this.client = client;
    // Si RemoteAuth tiene un método setup, lo llamamos
    if (super.setup) {
      super.setup(client);
    }
  }
}

module.exports = SupabaseRemoteAuth;
