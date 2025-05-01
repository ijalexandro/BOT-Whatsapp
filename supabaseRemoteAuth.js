const { RemoteAuth } = require('whatsapp-web.js');

class SupabaseRemoteAuth extends RemoteAuth {
  constructor(clientId, supabase) {
    super(clientId);
    this.supabase = supabase; // Cliente de Supabase inicializado previamente
  }

  // Recuperar la sesión desde Supabase al iniciar
  async getAuthData() {
    const { data, error } = await this.supabase
      .from('whatsapp_sessions')
      .select('session_data')
      .eq('client_id', this.clientId)
      .single();

    if (error || !data) {
      console.log('No se encontró sesión previa en Supabase:', error?.message || 'Sin datos');
      return null;
    }

    return JSON.parse(data.session_data);
  }

  // Guardar la sesión en Supabase después de autenticarse
  async saveAuthData(authData) {
    const sessionData = JSON.stringify(authData);
    const { error } = await this.supabase
      .from('whatsapp_sessions')
      .upsert({
        client_id: this.clientId,
        session_data: sessionData,
      });

    if (error) {
      console.error('Error al guardar la sesión en Supabase:', error.message);
    } else {
      console.log('Sesión guardada en Supabase con éxito.');
    }
  }
}

module.exports = SupabaseRemoteAuth;
