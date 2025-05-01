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
      return null; // Devolvemos null si no hay sesión
    }

    try {
      const sessionData = JSON.parse(data.session_data);
      console.log('Sesión encontrada en Supabase:', sessionData);
      return sessionData.session ? sessionData : {};
    } catch (parseError) {
      console.error('Error al parsear la sesión desde Supabase:', parseError.message);
      return null;
    }
  }

  async save(session) {
    console.log('Guardando sesión para clientId:', this.clientId);
    console.log('Datos de la sesión a guardar:', session);
    const sessionData = JSON.stringify({ session: session });
    const { data: existingSession, error: checkError } = await this.supabase
      .from('whatsapp_sessions')
      .select('client_id')
      .eq('client_id', this.clientId)
      .single();

    if (checkError && checkError.code !== 'PGRST116') {
      console.error('Error al verificar la existencia de la sesión antes de guardar:', checkError.message);
      throw new Error(`No se pudo verificar la sesión: ${checkError.message}`);
    }

    if (existingSession) {
      console.log('Sesión ya existe, actualizando...');
      const { error: updateError } = await this.supabase
        .from('whatsapp_sessions')
        .update({ session_data: sessionData })
        .eq('client_id', this.clientId);

      if (updateError) {
        console.error('Error al actualizar la sesión en Supabase:', updateError.message);
        throw new Error(`No se pudo actualizar la sesión: ${updateError.message}`);
      } else {
        console.log('Sesión actualizada en Supabase con éxito.');
      }
    } else {
      console.log('Sesión no existe, insertando nueva...');
      const { error: insertError } = await this.supabase
        .from('whatsapp_sessions')
        .insert({ client_id: this.clientId, session_data: sessionData });

      if (insertError) {
        console.error('Error al insertar la sesión en Supabase:', insertError.message);
        throw new Error(`No se pudo insertar la sesión: ${insertError.message}`);
      } else {
        console.log('Sesión insertada en Supabase con éxito.');
      }
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
