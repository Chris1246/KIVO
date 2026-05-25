// api/groq.js
// Vercel Serverless Function - Proxy seguro a la API de Groq
//
// Por que existe este archivo:
// - La API key de Groq NUNCA debe estar en el cliente (HTML/JS publico).
//   Cualquier persona puede ver el codigo fuente y robar la key.
// - Esta funcion corre en el servidor de Vercel. La key vive como env var
//   y nunca se expone al browser.
//
// Configuracion necesaria en Vercel (dashboard > Settings > Environment Variables):
//   GROQ_API_KEY = gsk_XXX...
//   ALLOWED_ORIGIN = https://tu-dominio.vercel.app  (opcional, default *)
//
// Endpoint: POST /api/groq
// Body: { messages: [...], model?: string, temperature?: number, max_tokens?: number }
// Response: el body crudo de Groq (compatible con el cliente actual)

// --- Rate limiting en memoria (simple, suficiente para volumen actual) ---
// Limites: 30 requests por IP cada 60 segundos, 200 por IP cada hora.
// Para volumen mayor, mover a Vercel KV o Upstash Redis.
var rateLimitStore = {};

function checkRateLimit(ip) {
  var now = Date.now();
  var minuteAgo = now - 60 * 1000;
  var hourAgo = now - 60 * 60 * 1000;

  if (!rateLimitStore[ip]) {
    rateLimitStore[ip] = { requests: [] };
  }

  // Limpiar registros viejos (>1h)
  rateLimitStore[ip].requests = rateLimitStore[ip].requests.filter(function(t) {
    return t > hourAgo;
  });

  var lastMinute = rateLimitStore[ip].requests.filter(function(t) {
    return t > minuteAgo;
  }).length;
  var lastHour = rateLimitStore[ip].requests.length;

  if (lastMinute >= 30) {
    return { allowed: false, reason: 'Demasiadas peticiones por minuto. Espera 60 segundos.', retryAfter: 60 };
  }
  if (lastHour >= 200) {
    return { allowed: false, reason: 'Limite horario alcanzado. Espera unos minutos.', retryAfter: 600 };
  }

  rateLimitStore[ip].requests.push(now);
  return { allowed: true };
}

// Limpieza periodica del store (cada 100 requests, purga IPs sin actividad reciente)
var cleanupCounter = 0;
function maybeCleanup() {
  cleanupCounter++;
  if (cleanupCounter < 100) return;
  cleanupCounter = 0;
  var hourAgo = Date.now() - 60 * 60 * 1000;
  Object.keys(rateLimitStore).forEach(function(ip) {
    var requests = rateLimitStore[ip].requests;
    if (requests.length === 0 || requests[requests.length - 1] < hourAgo) {
      delete rateLimitStore[ip];
    }
  });
}

// --- Allow-list de modelos ---
var ALLOWED_MODELS = [
  'llama-3.3-70b-versatile'
];

function getClientIp(req) {
  var fwd = req.headers['x-forwarded-for'];
  if (fwd) return fwd.split(',')[0].trim();
  return req.headers['x-real-ip'] || req.socket && req.socket.remoteAddress || 'unknown';
}

module.exports = async function handler(req, res) {
  // --- CORS ---
  var allowedOrigin = process.env.ALLOWED_ORIGIN || '*';
  res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed. Use POST.' });
  }

  // --- Rate limiting ---
  var ip = getClientIp(req);
  var rateCheck = checkRateLimit(ip);
  maybeCleanup();
  if (!rateCheck.allowed) {
    res.setHeader('Retry-After', String(rateCheck.retryAfter));
    return res.status(429).json({ error: rateCheck.reason });
  }

  // --- Validar API key esta configurada ---
  var apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    console.error('GROQ_API_KEY no configurada en environment variables.');
    return res.status(500).json({ error: 'Servidor mal configurado. Contacta al administrador.' });
  }

  // --- Validar body ---
  var body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) {
      return res.status(400).json({ error: 'Body invalido. Debe ser JSON.' });
    }
  }
  if (!body || !Array.isArray(body.messages) || body.messages.length === 0) {
    return res.status(400).json({ error: 'Body debe incluir messages: [...].' });
  }

  // --- Allow-list de modelos ---
  var model = body.model || 'llama-3.3-70b-versatile';
  if (ALLOWED_MODELS.indexOf(model) === -1) {
    return res.status(400).json({ error: 'Modelo no permitido. Modelos disponibles: ' + ALLOWED_MODELS.join(', ') });
  }

  // --- Sanitizar parametros ---
  var temperature = typeof body.temperature === 'number' ? body.temperature : 0.7;
  if (temperature < 0) temperature = 0;
  if (temperature > 2) temperature = 2;

  var maxTokens = typeof body.max_tokens === 'number' ? body.max_tokens : 1000;
  if (maxTokens < 1) maxTokens = 1;
  if (maxTokens > 8000) maxTokens = 8000; // hard cap para controlar costos

  // --- Construir payload para Groq ---
  var groqPayload = {
    model: model,
    messages: body.messages,
    temperature: temperature,
    max_tokens: maxTokens
  };
  if (body.response_format) groqPayload.response_format = body.response_format;

  // --- Llamar a Groq ---
  try {
    var groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + apiKey
      },
      body: JSON.stringify(groqPayload)
    });

    var data = await groqRes.json();

    if (!groqRes.ok) {
      // Pasar el error de Groq pero sin filtrar info interna
      var errMsg = (data && data.error && data.error.message) || 'Error en el modelo.';
      // No registrar prompts ni respuestas en logs
      console.error('Groq error status=' + groqRes.status + ' code=' + (data && data.error && data.error.code));
      return res.status(groqRes.status).json({ error: errMsg });
    }

    return res.status(200).json(data);

  } catch (e) {
    console.error('Network error to Groq:', e.message);
    return res.status(502).json({ error: 'No se pudo contactar al modelo. Intenta de nuevo.' });
  }
};
