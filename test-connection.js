const https = require('https');

// Prueba 1: Conexión a Google
https.get('https://www.google.com', (res) => {
  console.log('Conexión exitosa a Google:', res.statusCode);
}).on('error', (e) => {
  console.error('Error al conectar a Google:', e.message);
});

// Prueba 2: Conexión a Dialogflow (dominio oficial)
https.get('https://dialogflow.googleapis.com', (res) => {
  console.log('Conexión exitosa a Dialogflow:', res.statusCode);
}).on('error', (e) => {
  console.error('Error al conectar a Dialogflow:', e.message);
});