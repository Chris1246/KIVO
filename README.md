# KIVO - Deployment a Vercel

Este proyecto contiene KIVO (Knowledge In, Value Out) listo para deployar a Vercel con la API key de Groq protegida server-side.

## Estructura

```
kivo-vercel/
  api/
    groq.js          <- Serverless function (proxy seguro a Groq)
  public/
    index.html       <- KIVO frontend (sin API key)
  vercel.json        <- Configuracion de Vercel (rutas, headers, CORS)
  README.md          <- Este archivo
  .gitignore
```

## Deploy paso a paso

### 1. Subir a Vercel (primera vez)

Opcion A - Via Vercel CLI:

```bash
npm install -g vercel
cd kivo-vercel
vercel
```

Sigue las instrucciones interactivas. Cuando pregunte "Want to override settings?" responde **No**, el vercel.json ya lo tiene todo configurado.

Opcion B - Via GitHub:

1. Crea un repo nuevo en GitHub.
2. Sube los archivos.
3. En vercel.com, click "Add New Project" y conecta el repo.
4. Deploy.

### 2. Configurar la API key (CRITICO)

En el dashboard de Vercel:

1. Ve a tu proyecto > Settings > Environment Variables.
2. Agrega:

| Name | Value | Environments |
|---|---|---|
| `GROQ_API_KEY` | `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` | Production, Preview, Development |
| `ALLOWED_ORIGIN` | `https://tu-proyecto.vercel.app` (opcional, default `*`) | Production |

3. Despues de agregar la env var, **redeploy** el proyecto (el cambio NO se aplica automaticamente).

### 3. Revocar y rotar la API key vieja (IMPORTANTE)

Una vez deployado y funcionando:

1. Ve al dashboard de Groq (console.groq.com).
2. **Revoca la key actual** (`gsk_la4qXUl0PrQt...`). Esta key fue expuesta publicamente y debe darse por comprometida.
3. **Genera una nueva key**.
4. Actualiza la env var `GROQ_API_KEY` en Vercel con la nueva key.
5. Redeploy.

Por que esto importa: si alguien copio la key mientras estuvo expuesta en Netlify, puede seguir usandola hasta que la revoques manualmente.

## Testing local

```bash
npm install -g vercel
cd kivo-vercel
echo "GROQ_API_KEY=gsk_tu_key_aqui" > .env.local
vercel dev
```

Esto levanta el frontend en `localhost:3000` y la function en `localhost:3000/api/groq`.

## Verificacion post-deploy

1. Abre la URL de Vercel en el browser.
2. Click derecho > Ver codigo fuente.
3. Busca "gsk_" en el codigo. **No debe aparecer.**
4. Busca "/api/groq". **Debe aparecer en safeGroqCall.**
5. Carga un brief de prueba y verifica que se analiza normalmente.

## Limites configurados

- **Rate limit por IP**: 30 requests/minuto, 200 requests/hora.
- **max_tokens cap**: 8000 (hard cap server-side).
- **Modelos permitidos**: solo `llama-3.3-70b-versatile`.
- **Timeout de la function**: 30 segundos.

Para volumen mayor (>200 usuarios concurrentes), migrar el rate limiting a Vercel KV o Upstash Redis.

## Migracion desde Netlify

Una vez Vercel este funcionando:

1. Confirma que el sitio Vercel funciona correctamente.
2. (Opcional) Apunta tu dominio custom a Vercel.
3. Apaga el sitio en Netlify para evitar que sigan haciendose llamadas con la key vieja.
