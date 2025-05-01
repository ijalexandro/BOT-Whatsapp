class SupabaseStore {
  constructor(supabase, clientId) {
    this.supabase = supabase;
    this.clientId = clientId;
  }

  // Método para inicializar la conexión
  async connect() {
    console.log('Conectando SupabaseStore para clientId:', this.clientId);
  }

  // Método para obtener la sesión desde Supabase
  async getSession() {
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

  // Método para guardar la sesión en Supabase
  async save(session) {
    const sessionData = JSON.stringify(session);
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

  // Método para extraer la sesión
  async extract() {
    return this.getSession();
  }

  // Método para eliminar la sesión
  async remove() {
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

  // Nuevo método para verificar si la sesión existe
  async sessionExists() {
    const { data, error } = await this.supabase
      .from('whatsapp_sessions')
      .select('client_id')
      .eq('client_id', this.clientId)
      .single();

    if (error && error.code === 'PGRST116') {
      // PGRST116 indica que no se encontró la fila (no existe)
      return false;
    } else if (error) {
      console.error('Error al verificar la existencia de la sesión:', error.message);
      return false;
    }

    return !!data; // Devuelve true si hay datos, false si no
  }
}

module.exports = SupabaseStore;
