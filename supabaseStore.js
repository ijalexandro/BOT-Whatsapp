class SupabaseStore {
  constructor(supabase, clientId) {
    if (!supabase || !clientId) {
      throw new Error('Supabase y clientId son requeridos para SupabaseStore');
    }

    this.supabase = supabase;
    this.clientId = clientId;
  }

  async connect() {
    console.log(`[SupabaseStore] Conectando para clientId: ${this.clientId}`);
  }

  async getSession() {
    console.log(`[SupabaseStore] Obteniendo sesión para clientId: ${this.clientId}`);

    const { data, error } = await this.supabase
      .from('whatsapp_sessions')
      .select('session_data')
      .eq('client_id', this.clientId)
      .single();

    if (error || !data) {
      console.warn('[SupabaseStore] Sesión no encontrada o error:', error?.message || 'Sin datos');
      return null;
    }

    try {
      const parsed = JSON.parse(data.session_data);
      return parsed.session ? parsed : {};
    } catch (err) {
      console.error('[SupabaseStore] Error al parsear sesión:', err.message);
      return null;
    }
  }

  async save(session) {
    console.log(`[SupabaseStore] Guardando sesión para clientId: ${this.clientId}`);
    const sessionData = JSON.stringify({ session });

    const { data: existing, error: checkError } = await this.supabase
      .from('whatsapp_sessions')
      .select('client_id')
      .eq('client_id', this.clientId)
      .single();

    if (checkError && checkError.code !== 'PGRST116') {
      console.error('[SupabaseStore] Error al verificar existencia:', checkError.message);
      throw new Error('Error al guardar sesión');
    }

    if (existing) {
      const { error: updateError } = await this.supabase
        .from('whatsapp_sessions')
        .update({ session_data: sessionData })
        .eq('client_id', this.clientId);

      if (updateError) {
        throw new Error(`[SupabaseStore] No se pudo actualizar sesión: ${updateError.message}`);
      }
      console.log('[SupabaseStore] Sesión actualizada');
    } else {
      const { error: insertError } = await this.supabase
        .from('whatsapp_sessions')
        .insert({ client_id: this.clientId, session_data: sessionData });

      if (insertError) {
        throw new Error(`[SupabaseStore] No se pudo insertar sesión: ${insertError.message}`);
      }
      console.log('[SupabaseStore] Sesión insertada');
    }
  }

  async extract() {
    return this.getSession();
  }

  async remove() {
    console.log(`[SupabaseStore] Eliminando sesión para clientId: ${this.clientId}`);
    const { error } = await this.supabase
      .from('whatsapp_sessions')
      .delete()
      .eq('client_id', this.clientId);

    if (error) {
      console.error('[SupabaseStore] Error al eliminar sesión:', error.message);
    } else {
      console.log('[SupabaseStore] Sesión eliminada');
    }
  }

  async sessionExists() {
    console.log(`[SupabaseStore] Verificando existencia de sesión para clientId: ${this.clientId}`);
    const { data, error } = await this.supabase
      .from('whatsapp_sessions')
      .select('client_id')
      .eq('client_id', this.clientId)
      .single();

    if (error && error.code === 'PGRST116') {
      return false;
    } else if (error) {
      console.error('[SupabaseStore] Error al consultar existencia:', error.message);
      return false;
    }

    return !!data;
  }
}

module.exports = SupabaseStore;
