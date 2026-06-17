import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const Afip = require('@afipsdk/afip.js');

const EMAILS_OK = ['juliandilullo@gmail.com', 'sof.cosen@gmail.com'];

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { tipo, cuitCliente, condicionIva, impTotal, envio: envioRaw, conIva, userEmail, items: pedidoItems } = req.body;

    if (!EMAILS_OK.includes(userEmail)) {
      return res.status(403).json({ error: 'No autorizado' });
    }

    // Leer cert y key desde env (con saltos de línea reales)
    const CERT = (process.env.AFIP_CERT || '').replace(/\\n/g, '\n').trim();
    const KEY  = (process.env.AFIP_KEY  || '').replace(/\\n/g, '\n').trim();
    const CUIT = process.env.AFIP_CUIT;
    const ACCESS_TOKEN = process.env.AFIP_ACCESS_TOKEN;

    console.log('CERT ok:', CERT.startsWith('-----BEGIN CERTIFICATE'));
    console.log('KEY ok:', KEY.startsWith('-----BEGIN RSA PRIVATE KEY') || KEY.startsWith('-----BEGIN PRIVATE KEY'));

    // Instanciar SDK
    const afip = new Afip({
      CUIT:         parseInt(CUIT),
      cert:         CERT,
      key:          KEY,
      access_token: ACCESS_TOKEN,
      production:   true,
    });

    // Calcular importes según lógica personalizada
    const itemsSubtotal = Math.round(parseFloat(impTotal) * 100) / 100;
    const envio         = Math.round((parseFloat(envioRaw) || 0) * 100) / 100;

    let netoItems, ivaItems, netoEnvio, ivaEnvio;

    if (conIva) {
      // Precio de lista NO incluye IVA → sumar 21% a items; envío: dividir por 1.21
      netoItems = itemsSubtotal;
      ivaItems  = Math.round(itemsSubtotal * 0.21 * 100) / 100;
      netoEnvio = envio > 0 ? Math.round(envio / 1.21 * 100) / 100 : 0;
      ivaEnvio  = envio > 0 ? Math.round((envio - netoEnvio) * 100) / 100 : 0;
    } else {
      // Precio de lista YA incluye IVA → dividir por 1.21 para sacar neto
      netoItems = Math.round(itemsSubtotal / 1.21 * 100) / 100;
      ivaItems  = Math.round((itemsSubtotal - netoItems) * 100) / 100;
      netoEnvio = envio > 0 ? Math.round(envio / 1.21 * 100) / 100 : 0;
      ivaEnvio  = envio > 0 ? Math.round((envio - netoEnvio) * 100) / 100 : 0;
    }

    const neto    = Math.round((netoItems + netoEnvio) * 100) / 100;
    const ivaAmt  = Math.round((ivaItems + ivaEnvio) * 100) / 100;
    const total   = Math.round((neto + ivaAmt) * 100) / 100;
    const opEx    = 0; // Siempre gravado

    // Tipo de comprobante y receptor
    const cbteTipo  = tipo === 'A' ? 1 : 6;
    const docTipo   = tipo === 'A' ? 80 : 99;
    const docNro    = tipo === 'A' ? parseInt((cuitCliente || '').replace(/[-]/g, '')) : 0;

    // condicionIva → CondicionIVAReceptorId
    // Para Factura A el receptor SIEMPRE debe ser RI (id:1) — AFIP error 10243 si no
    const condMap   = { RI: 1, EX: 4, CF: 5, MONO: 6 };
    const condIvaId = tipo === 'A' ? 1 : (condMap[condicionIva] || 5);

    const ptoVta = 10;
    // Fecha local Argentina (UTC-3) para evitar que de madrugada tome el día anterior
    const now = new Date(Date.now() - ((new Date()).getTimezoneOffset() * 60000));
    const fecha  = parseInt(now.toISOString().split('T')[0].replace(/-/g, ''));

    // Armar objeto de comprobante
    const voucherData = {
      PtoVta:    ptoVta,
      CbteTipo:  cbteTipo,
      Concepto:  1,          // Productos
      DocTipo:   docTipo,
      DocNro:    docNro,
      CbteFch:   fecha,
      ImpTotal:  total,
      ImpTotConc: 0,
      ImpNeto:   neto,
      ImpOpEx:   opEx,
      ImpIVA:    ivaAmt,
      ImpTrib:   0,
      MonId:     'PES',
      MonCotiz:  1,
      CondicionIVAReceptorId: condIvaId,
      ...(ivaAmt > 0 && {
        Iva: [
          {
            Id:       5,        // 21%
            BaseImp:  neto,
            Importe:  ivaAmt,
          }
        ]
      }),
    };

    console.log('VoucherData:', JSON.stringify(voucherData));

    // Crear comprobante (obtiene último nro automáticamente y asigna CAE)
    const result = await afip.ElectronicBilling.createNextVoucher(voucherData);

    console.log('Result:', JSON.stringify(result));

    // Formatear fechas para el PDF (DD/MM/YYYY)
    const fmtDate = (str) => {
      // str puede ser yyyymmdd (CbteFch) o yyyy-mm-dd (CAEFchVto)
      const s = String(str).replace(/-/g, '');
      return s.slice(6,8) + '/' + s.slice(4,6) + '/' + s.slice(0,4);
    };
    const fechaEmision  = fmtDate(fecha);
    const fechaVtoCae   = fmtDate(result.CAEFchVto);

    // Mapas legibles
    const condIvaStr = { RI:'Responsable Inscripto', EX:'Exento', CF:'Consumidor Final', MONO:'Monotributista' };
    const templateName = tipo === 'A' ? 'invoice-a' : 'invoice-b';

    const pdfItems = Array.isArray(pedidoItems) && pedidoItems.length > 0
      ? pedidoItems.map((it, i) => ({
          code:        String(i + 1).padStart(3, '0'),
          description: String(it.nombre),
          quantity:    Number(it.cantidad) || 1,
          unit_price:  Number(it.precio) || 0,
          subtotal:    Math.round((Number(it.precio) || 0) * (Number(it.cantidad) || 1) * 100) / 100,
          ...(tipo === 'A' && { vat_rate: 21 }),  // Factura A requiere alícuota IVA por item
        }))
      : [{ code: '001', description: 'Productos de panadería artesanal', quantity: 1, unit_price: total, subtotal: total, ...(tipo === 'A' && { vat_rate: 21 }) }];

    const baseParams = {
      voucher_number:            result.voucherNumber,
      sales_point:               ptoVta,
      issue_date:                fechaEmision,
      cae_due_date:              fechaVtoCae,
      issuer_cuit:               parseInt(CUIT),
      cae:                       parseInt(result.CAE),
      issuer_business_name:      'Julian Nicolas Di Lullo',
      issuer_address:            'CABA, Buenos Aires',
      issuer_iva_condition:      'Responsable Inscripto',
      issuer_gross_income:       String(CUIT),
      issuer_activity_start_date:'01/01/2020',
      receiver_name:             tipo === 'A' ? String(req.body.cliente || cuitCliente || '-') : 'CONSUMIDOR FINAL',
      receiver_address:          '-',
      receiver_document_type:    docTipo,
      receiver_document_number:  docNro,
      receiver_iva_condition:    tipo === 'A' ? 'Responsable Inscripto' : (condIvaStr[condicionIva] || 'Consumidor Final'),
      sale_condition:            'Contado',
      currency_id:               'ARS',
      currency_rate:             1,
      concept:                   1,
      items:                     pdfItems,
      vat_amount:                ivaAmt,
      tributes_amount:           0,
      total_amount:              total,
    };

    // Factura A requiere campos extra obligatorios
    if (tipo === 'A') {
      baseParams.net_amount_taxed   = neto;
      baseParams.net_amount_untaxed = 0;
      baseParams.exempt_amount      = 0;
      baseParams.vat_breakdown      = [{ vat_rate_id: 21, taxable_base: neto, vat_subtotal: ivaAmt }];
    }

    const pdfData = {
      file_name: `factura-${tipo}-${result.voucherNumber}.pdf`,
      template: { name: templateName, params: baseParams }
    };

    console.log('PDF pdfData enviado:', JSON.stringify(pdfData, null, 2));
    let pdfResult;
    try {
      pdfResult = await afip.ElectronicBilling.createPDF(pdfData);
    } catch(pdfErr) {
      // Capturar body completo del error de Axios
      const axiosData = pdfErr.response?.data;
      console.error('createPDF error body:', JSON.stringify(axiosData, null, 2));
      throw new Error('createPDF 400: ' + JSON.stringify(axiosData));
    }
    console.log('PDF URL temporal AfipSDK:', pdfResult.file);

    // Descargar PDF desde AfipSDK y subir a Supabase Storage para URL permanente
    let pdfUrlFinal = pdfResult.file;
    try {
      const pdfResponse = await fetch(pdfResult.file);
      if (pdfResponse.ok) {
        const pdfBuffer = await pdfResponse.arrayBuffer();
        const pdfBytes  = new Uint8Array(pdfBuffer);
        const fileName  = pdfData.file_name;
        const uploadRes = await fetch(
          `${SUPA_URL}/storage/v1/object/facturas/${fileName}`,
          {
            method: 'POST',
            headers: {
              'apikey':        SUPA_ANON,
              'Authorization': `Bearer ${SUPA_ANON}`,
              'Content-Type':  'application/pdf',
              'x-upsert':      'true',
            },
            body: pdfBytes
          }
        );
        if (uploadRes.ok) {
          pdfUrlFinal = `${SUPA_URL}/storage/v1/object/public/facturas/${fileName}`;
          console.log('PDF subido a Supabase Storage:', pdfUrlFinal);
        } else {
          const uploadErr = await uploadRes.text();
          console.error('Error subiendo PDF a Supabase Storage:', uploadErr);
        }
      }
    } catch(uploadErr) {
      console.error('Error descargando/subiendo PDF:', uploadErr.message);
    }

    // Guardar en Supabase tabla facturas
    const SUPA_URL = 'https://zuuvvhhpcdngvauonxms.supabase.co';
    // Usar anon key — RLS debe estar deshabilitado en tabla facturas
    const SUPA_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inp1dXZ2aGhwY2RuZ3ZhdW9ueG1zIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA0MTA0MjYsImV4cCI6MjA5NTk4NjQyNn0.sYbXyOTmN8qDraFLgk0ifiPU3NHr0Ezb3PaqrTywFxQ';

    const facturaPayload = {
      pedido_id:    String(req.body.pedidoId || ''),
      cliente:      String(req.body.cliente  || ''),
      tipo:         String(tipo),
      nro:          Number(result.voucherNumber),
      punto_venta:  Number(ptoVta),
      cae:          String(result.CAE),
      cae_vto:      String(result.CAEFchVto),
      total:        Number(total),
      con_iva:      !!conIva,
      pdf_url:      String(pdfResult.file || ''),
      fecha_emision: now.toISOString().split('T')[0],
    };
    console.log('Guardando factura:', JSON.stringify(facturaPayload));
    console.log('PDF baseParams:', JSON.stringify(baseParams, null, 2));

    try {
      const saveRes = await fetch(`${SUPA_URL}/rest/v1/facturas`, {
        method: 'POST',
        headers: {
          'apikey': SUPA_ANON,
          'Authorization': `Bearer ${SUPA_ANON}`,
          'Content-Type': 'application/json',
          'Prefer': 'return=minimal'
        },
        body: JSON.stringify(facturaPayload)
      });
      if (!saveRes.ok) {
        const errText = await saveRes.text();
        console.error('Supabase error guardando factura:', saveRes.status, errText);
      } else {
        console.log('Factura guardada en Supabase OK');
      }
    } catch(saveErr) {
      console.error('Error guardando factura en Supabase:', saveErr.message);
      // No interrumpir — la factura ya fue emitida en AFIP
    }

    return res.status(200).json({
      ok:             true,
      CAE:            result.CAE,
      CAEFchVto:      result.CAEFchVto,
      nroComprobante: result.voucherNumber,
      tipo,
      total,
      puntoVenta:     ptoVta,
      pdfUrl:         pdfUrlFinal,
    });

  } catch (e) {
    console.error('Error facturar:', e.message, JSON.stringify(e.data || e.response?.data || {}, null, 2));
    console.error('Error facturar full:', JSON.stringify(e, Object.getOwnPropertyNames(e), 2));
    return res.status(500).json({ error: e.message, detail: e.data || null });
  }
}
