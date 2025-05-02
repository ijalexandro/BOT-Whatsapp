const { RemoteAuth } = require('whatsapp-web.js');
const SupabaseStore = require('./supabaseStore');

class SupabaseRemoteAuth extends RemoteAuth {
  constructor(options) {
    // Validar las opciones recibidas
    const { clientId, supabase } = options || {};
    if (!clientId || !supabase) {
      throw new Error('clientId y supabase son requeridos para SupabaseRemoteAuth');
    }

    // Crear el store con Supabase
    const store = new SupabaseStore(supabase, clientId);

    // Llamar al constructor de RemoteAuth con el objeto de opciones correcto
    super({
      clientId: clientId,
      store: store,
      backupSyncIntervalMs: 300000, // 5 minutos
      dataPath: null // Sin archivos locales
    });

    // Guardar las opciones para uso interno si es necesario
    this.options = options;
  }

  // Método requerido por whatsapp-web.js
  setup(client) {
    this.client = client;
    if (super.setup) {
      super.setup(client);
    }
  }
}

module.exports = SupabaseRemoteAuth;
