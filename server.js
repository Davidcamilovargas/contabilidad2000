require('dotenv').config();
const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.ANTHROPIC_API_KEY;

if (!API_KEY) {
  console.error('\n[ERROR] No se encontró ANTHROPIC_API_KEY en el archivo .env');
  console.error('Copia .env.example a .env y agrega tu clave de API antes de iniciar el servidor.\n');
  process.exit(1);
}

app.use(express.json({ limit: '20mb' })); // las facturas en base64 pueden pesar varios MB
app.use(express.static(path.join(__dirname, 'public')));

// Endpoint que recibe el archivo (imagen o PDF) y llama a la API de Anthropic
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

  const fileBlock = isPdf
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } }
    : { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } };

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1000,
        messages: [
          {
            role: 'user',
            content: [fileBlock, { type: 'text', text: prompt }]
          }
        ]
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error('Error de Anthropic API:', response.status, errText);
      return res.status(response.status).json({ error: `Error de la API de Anthropic (${response.status})` });
    }

    const data = await response.json();
    const textBlock = (data.content || []).find(b => b.type === 'text');

    if (!textBlock) {
      return res.status(500).json({ error: 'No se recibió una respuesta de texto de la API.' });
    }

    let clean = textBlock.text.trim();
    clean = clean.replace(/^```json/i, '').replace(/^```/, '').replace(/```$/, '').trim();

    let parsed;
    try {
      parsed = JSON.parse(clean);
    } catch (parseErr) {
      return res.status(500).json({ error: 'No se pudo interpretar la respuesta de la IA. Intenta con una imagen más clara.' });
    }

    res.json(parsed);

  } catch (err) {
    console.error('Error al llamar a Anthropic:', err);
    res.status(500).json({ error: 'Error de conexión con la API de Anthropic.' });
  }
});

app.listen(PORT, () => {
  console.log(`\n✔ Escáner de Facturas corriendo en http://localhost:${PORT}\n`);
});
