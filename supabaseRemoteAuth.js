const { RemoteAuth } = require('whatsapp-web.js');
const SupabaseStore = require('./supabaseStore');

class SupabaseRemoteAuth extends RemoteAuth {
  constructor(options) {
    const { clientId, supabase } = options || {};
    if (!clientId || !supabase) {
      throw new Error('clientId y supabase son requeridos para SupabaseRemoteAuth');
    }
    const store = new SupabaseStore(supabase, clientId);

    // Configurar RemoteAuth sin dependencia de archivos locales
    super({
      clientId: clientId,
      store: store,
      backupSyncIntervalMs: 300000, // 5 minutos
      dataPath: undefined // Forzar que no use archivos locales (null no siempre funciona)
    });

    this.options = options;
  }

  setup(client) {
    this.client = client;
    if (super.setup) {
      super.setup(client);
    }
    // Asegurar que no intente guardar en disco
    this.client.on('auth_failure', () => {
      console.error('Fallo de autenticación, revisando configuración de RemoteAuth');
    });
  }
}

module.exports = SupabaseRemoteAuth;
