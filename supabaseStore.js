class SupabaseStore {
  constructor(supabase, clientId) {
    this.supabase = supabase;
    this.clientId = clientId;
  }

  // Método para inicializar la conexión (puede ser vacío si no necesitamos lógica adicional)
  async connect() {
    console.log('Conectando SupabaseStore para clientId:', this.clientId);
    // No necesitamos lógica adicional porque Supabase ya está inicializado
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

  // Método para extraer la sesión (similar a getSession, usado en ciertos casos)
  async extract() {
    return this.getSession();
  }

  // Método para eliminar la sesión (opcional, pero lo implementamos por completitud)
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
}

module.exports = SupabaseStore;
