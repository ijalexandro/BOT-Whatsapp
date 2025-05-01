class SupabaseStore {
  constructor(supabase, clientId) {
    this.supabase = supabase;
    this.clientId = clientId;
  }

  async connect() {
    console.log('Conectando SupabaseStore para clientId:', this.clientId);
  }

  async getSession() {
    console.log('Intentando obtener sesión para clientId:', this.clientId);
    const { data, error } = await this.supabase
      .from('whatsapp_sessions')
      .select('session_data')
      .eq('client_id', this.clientId)
      .single();

    if (error || !data) {
      console.log('No se encontró sesión previa en Supabase:', error?.message || 'Sin datos');
      return null;
    }

    console.log('Sesión encontrada en Supabase:', data.session_data);
    return JSON.parse(data.session_data);
  }

  async save(session) {
    console.log('Guardando sesión para clientId:', this.clientId);
    console.log('Datos de la sesión a guardar:', session);
    const sessionData = JSON.stringify(session);
    const { error } = await this.supabase
      .from('whatsapp_sessions')
      .upsert({
        client_id: this.clientId,
        session_data: sessionData,
      });

    if (error) {
      console.error('Error al guardar la sesión en Supabase:', error.message);
      throw new Error(`No se pudo guardar la sesión: ${error.message}`);
    } else {
      console.log('Sesión guardada en Supabase con éxito.');
    }
  }

  async extract() {
    return this.getSession();
  }

  async remove() {
    console.log('Eliminando sesión para clientId:', this.clientId);
    const { error } = await this.supabase
      .from('whatsapp_sessions')
      .delete()
      .eq('client_id', this.clientId);

    if (error) {
      console.error('Error al eliminar la sesión en Supabase:', error.message);
    } else {
      console.log('Sesión eliminada de Supabase con éxito.');
    }
  }

  async sessionExists() {
    console.log('Verificando si existe sesión para clientId:', this.clientId);
    const { data, error } = await this.supabase
      .from('whatsapp_sessions')
      .select('client_id')
      .eq('client_id', this.clientId)
      .single();

    if (error && error.code === 'PGRST116') {
      console.log('Sesión no encontrada (PGRST116)');
      return false;
    } else if (error) {
      console.error('Error al verificar la existencia de la sesión:', error.message);
      return false;
    }

    console.log('Sesión encontrada:', !!data);
    return !!data;
  }
}

module.exports = SupabaseStore;
