require('dotenv').config();
const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.GEMINI_API_KEY;

if (!API_KEY) {
  console.error('\n[ERROR] No se encontró GEMINI_API_KEY en el archivo .env');
  console.error('Copia .env.example a .env y agrega tu clave gratuita de Google AI Studio antes de iniciar el servidor.\n');
  process.exit(1);
}

app.use(express.json({ limit: '20mb' })); // las facturas en base64 pueden pesar varios MB
app.use(express.static(path.join(__dirname, 'public')));

// Modelo gratuito de Gemini. Si en el futuro Google lo retira, cambia este valor
// por el modelo Flash vigente (revisa https://ai.google.dev/gemini-api/docs/models).
const GEMINI_MODEL = 'gemini-3.1-flash-lite';

// Endpoint que recibe el archivo (imagen o PDF) y llama a la API gratuita de Gemini
app.post('/api/extract', async (req, res) => {
  const { base64, mediaType, isPdf } = req.body;

  if (!base64 || !mediaType) {
    return res.status(400).json({ error: 'Faltan datos del archivo (base64 o mediaType).' });
  }

  const prompt = `Eres un asistente contable. Analiza la imagen o documento de esta factura colombiana y extrae EXACTAMENTE estos campos, devolviendo SOLO un objeto JSON válido, sin texto adicional, sin markdown, sin backticks:

{
  "tipo_doc": "13 si el proveedor se identifica con cédula, 31 si es NIT. Si no es claro, usa el que aplique según el número.",
  "nit_cc": "número de identificación del proveedor/emisor, solo dígitos",
  "dv": "dígito de verificación si aparece, si no aparece pon una cadena vacía",
  "nombre_razon_social": "nombre o razón social del proveedor/emisor de la factura",
  "letras_fe": "prefijo alfabético de la factura electrónica si existe (ej: FE, SETP), si no existe cadena vacía",
  "numeros_fe": "número o consecutivo de la factura electrónica, solo el número",
  "fecha_factura": "fecha de la factura en formato DD/MM/AAAA",
  "valor_sin_iva": "valor total ANTES de IVA como número sin símbolos ni separadores de miles, usa punto decimal si aplica. Si la factura no discrimina IVA, usa el valor total.",
  "concepto": "breve descripción de qué es el gasto o servicio facturado, en pocas palabras"
}

Si algún campo no se puede determinar con certeza, usa una cadena vacía "" para ese campo. No inventes datos.`;

  const effectiveMediaType = isPdf ? 'application/pdf' : mediaType;

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': API_KEY
        },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                { inline_data: { mime_type: effectiveMediaType, data: base64 } },
                { text: prompt }
              ]
            }
          ]
        })
      }
    );

    if (!response.ok) {
      const errText = await response.text();
      console.error('Error de Gemini API:', response.status, errText);
      let detail = errText;
      try {
        const parsedErr = JSON.parse(errText);
        detail = parsedErr.error?.message || errText;
      } catch (_) { /* dejar el texto crudo si no es JSON */ }
      return res.status(response.status).json({ error: `Error de la API de Gemini (${response.status}): ${detail}` });
    }

    const data = await response.json();
    const textOut = data.candidates?.[0]?.content?.parts?.[0]?.text;

    if (!textOut) {
      return res.status(500).json({ error: 'No se recibió una respuesta de texto de la API.' });
    }

    let clean = textOut.trim();
    clean = clean.replace(/^```json/i, '').replace(/^```/, '').replace(/```$/, '').trim();

    let parsed;
    try {
      parsed = JSON.parse(clean);
    } catch (parseErr) {
      return res.status(500).json({ error: 'No se pudo interpretar la respuesta de la IA. Intenta con una imagen más clara.' });
    }

    res.json(parsed);

  } catch (err) {
    console.error('Error al llamar a Gemini:', err);
    res.status(500).json({ error: 'Error de conexión con la API de Gemini.' });
  }
});

app.listen(PORT, () => {
  console.log(`\n✔ Escáner de Facturas corriendo en http://localhost:${PORT}\n`);
});