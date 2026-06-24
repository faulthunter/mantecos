import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const Afip = require('@afipsdk/afip.js');

const EMAILS_OK = ['juliandilullo@gmail.com', 'sof.cosen@gmail.com'];

// Este endpoint NUNCA llama a createNextVoucher / WSFE.
// Solo reconstruye el PDF a partir de una factura YA EMITIDA (CAE existente)
// y lo sube a Supabase Storage. No emite nada nuevo ante AFIP.

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const {
      userEmail, pedidoId, tipo, nro, cae, caeVto,
      cliente, cuitCliente, condicionIva, total, conIva, items
    } = req.body;

    if (!EMAILS_OK.includes(userEmail)) {
      return res.status(403).json({ error: 'No autorizado' });
    }
    if (!cae || !nro) {
      return res.status(400).json({ error: 'Faltan CAE o número de comprobante — no se puede regenerar sin una factura ya emitida' });
    }

    const SUPA_URL  = 'https://zuuvvhhpcdngvauonxms.supabase.co';
    const SUPA_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inp1dXZ2aGhwY2RuZ3ZhdW9ueG1zIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA0MTA0MjYsImV4cCI6MjA5NTk4NjQyNn0.sYbXyOTmN8qDraFLgk0ifiPU3NHr0Ezb3PaqrTywFxQ';

    const CERT = (process.env.AFIP_CERT || '').replace(/\\n/g, '\n').trim();
    const KEY  = (process.env.AFIP_KEY  || '').replace(/\\n/g, '\n').trim();
    const CUIT = process.env.AFIP_CUIT;
    const ACCESS_TOKEN = process.env.AFIP_ACCESS_TOKEN;

    const afip = new Afip({
      CUIT: parseInt(CUIT), cert: CERT, key: KEY,
      access_token: ACCESS_TOKEN, production: true,
    });

    // Recalcular neto/iva igual que en facturar.js, a partir del total ya emitido
    const ptoVta  = 10;
    const docTipo = tipo === 'A' ? 80 : 99;
    const docNro  = tipo === 'A' ? parseInt((cuitCliente || '').replace(/[-]/g, '')) : 0;

    const itemsSubtotal = (items || []).reduce((s, it) => s + Number(it.precio) * Number(it.cantidad), 0);
    const envio = 0;
    let netoItems, ivaItems;
    if (conIva) {
      netoItems = itemsSubtotal;
      ivaItems  = Math.round(itemsSubtotal * 0.21 * 100) / 100;
    } else {
      netoItems = Math.round(itemsSubtotal / 1.21 * 100) / 100;
      ivaItems  = Math.round((itemsSubtotal - netoItems) * 100) / 100;
    }
    const neto   = Math.round(netoItems * 100) / 100;
    const ivaAmt = Math.round(ivaItems * 100) / 100;

    const fmtDate = (str) => {
      const s = String(str).replace(/-/g, '');
      return s.slice(6,8) + '/' + s.slice(4,6) + '/' + s.slice(0,4);
    };
    // Usar la fecha de emisión original (created_at del pedido, vencimiento - 10 días)
    const fechaEmision = req.body.fechaEmision || fmtDate(String(caeVto).replace(/-/g,'')); // fallback
    const fechaVtoCae  = fmtDate(caeVto);

    const condIvaStr = { RI: 'Responsable Inscripto', EX: 'Exento', CF: 'Consumidor Final', MONO: 'Monotributista' };
    const templateName = tipo === 'A' ? 'invoice-a' : 'invoice-b';

    let receiverName = tipo === 'A' ? String(cliente || cuitCliente || '-') : 'CONSUMIDOR FINAL';
    const receiverAddress = '-';

    const pdfItems = (items || []).map((it, i) => ({
      code:        String(i + 1).padStart(3, '0'),
      description: String(it.nombre),
      quantity:    Number(it.cantidad) || 1,
      unit_price:  Number(it.precio) || 0,
      subtotal:    Math.round((Number(it.precio) || 0) * (Number(it.cantidad) || 1) * 100) / 100,
      ...(tipo === 'A' && { vat_rate: 21 }),
    }));

    const baseParams = {
      voucher_number: Number(nro),
      sales_point: ptoVta,
      issue_date: fechaEmision,
      cae_due_date: fechaVtoCae,
      issuer_cuit: parseInt(CUIT),
      cae: parseInt(cae),
      issuer_business_name: 'Julian Nicolas Di Lullo',
      issuer_address: 'CABA, Buenos Aires',
      issuer_iva_condition: 'Responsable Inscripto',
      issuer_gross_income: String(CUIT),
      issuer_activity_start_date: '01/01/2020',
      receiver_name: receiverName,
      receiver_address: receiverAddress,
      receiver_document_type: docTipo,
      receiver_document_number: docNro,
      receiver_iva_condition: tipo === 'A' ? 'Responsable Inscripto' : (condIvaStr[condicionIva] || 'Consumidor Final'),
      sale_condition: 'Contado',
      currency_id: 'ARS',
      currency_rate: 1,
      concept: 1,
      items: pdfItems,
      vat_amount: ivaAmt,
      tributes_amount: 0,
      total_amount: Number(total),
    };
    if (tipo === 'A') {
      baseParams.net_amount_taxed = neto;
      baseParams.net_amount_untaxed = 0;
      baseParams.exempt_amount = 0;
      baseParams.vat_breakdown = [{ vat_rate_id: 21, taxable_base: neto, vat_subtotal: ivaAmt }];
    }

    const fileName = `factura-${tipo}-${nro}.pdf`;
    const pdfData = { file_name: fileName, template: { name: templateName, params: baseParams } };

    console.log('Regenerando PDF (sin tocar AFIP):', JSON.stringify(pdfData, null, 2));

    let pdfResult;
    try {
      pdfResult = await afip.ElectronicBilling.createPDF(pdfData);
    } catch(pdfErr) {
      console.error('createPDF error body:', JSON.stringify(pdfErr.response?.data, null, 2));
      throw new Error('createPDF 400: ' + JSON.stringify(pdfErr.response?.data));
    }
    console.log('PDF temporal regenerado:', pdfResult.file);

    let pdfUrlFinal = pdfResult.file;
    const pdfResponse = await fetch(pdfResult.file);
    if (pdfResponse.ok) {
      const pdfBuffer = await pdfResponse.arrayBuffer();
      const pdfBytes  = Buffer.from(pdfBuffer);
      const uploadRes = await fetch(`${SUPA_URL}/storage/v1/object/facturas/${fileName}`, {
        method: 'POST',
        headers: {
          'apikey': SUPA_ANON, 'Authorization': `Bearer ${SUPA_ANON}`,
          'Content-Type': 'application/pdf', 'x-upsert': 'true',
        },
        body: pdfBytes
      });
      if (uploadRes.ok) {
        pdfUrlFinal = `${SUPA_URL}/storage/v1/object/public/facturas/${fileName}`;
      }
    }

    // Actualizar pdf_url en la tabla facturas
    if (pedidoId) {
      await fetch(`${SUPA_URL}/rest/v1/facturas?pedido_id=eq.${encodeURIComponent(pedidoId)}`, {
        method: 'PATCH',
        headers: {
          'apikey': SUPA_ANON, 'Authorization': `Bearer ${SUPA_ANON}`,
          'Content-Type': 'application/json', 'Prefer': 'return=minimal'
        },
        body: JSON.stringify({ pdf_url: pdfUrlFinal })
      });
    }

    return res.status(200).json({ ok: true, pdfUrl: pdfUrlFinal });

  } catch (e) {
    console.error('Error regenerando PDF:', e.message);
    return res.status(500).json({ error: e.message });
  }
}
