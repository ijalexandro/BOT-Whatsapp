const { RemoteAuth } = require('whatsapp-web.js');
const SupabaseStore = require('./supabaseStore');

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
      backupSyncIntervalMs: 300000, // cada 5 minutos
      dataPath: null // asegura que no se usen archivos locales
    });

    this.supabase = supabase;
    this.clientId = clientId;
    this.sessionName = `RemoteAuth-${clientId}`;
    console.log(`✅ SupabaseRemoteAuth configurado para clientId: ${clientId}`);
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
