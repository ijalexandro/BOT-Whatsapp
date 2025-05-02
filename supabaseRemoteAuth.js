const { RemoteAuth } = require('whatsapp-web.js');
const SupabaseStore = require('./supabaseStore');

class SupabaseRemoteAuth extends RemoteAuth {
  constructor(options) {
    const { clientId, supabase } = options || {};
    if (!clientId || !supabase) {
      throw new Error('clientId y supabase son requeridos para SupabaseRemoteAuth');
    }
    const store = new SupabaseStore(supabase, clientId);

    // Configurar RemoteAuth sin archivos locales
    super({
      clientId: clientId,
      store: store,
      backupSyncIntervalMs: 300000, // 5 minutos
      dataPath: undefined // Forzar no uso de archivos
    });

    // Asegurar que dataPath no se use
    this.dataPath = undefined;
    this.sessionName = `RemoteAuth-${clientId}`;
    console.log('Configuración de RemoteAuth completada para clientId:', clientId);
  }

  setup(client) {
    this.client = client;
    if (super.setup) {
      super.setup(client);
    }
    console.log('Método setup invocado para clientId:', this.clientId);
  }
}

module.exports = SupabaseRemoteAuth;
