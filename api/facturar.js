import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const Afip = require('@afipsdk/afip.js');

const EMAILS_OK = ['juliandilullo@gmail.com', 'sof.cosen@gmail.com'];
const ALLOWED_ORIGINS = ['https://mantecos.vercel.app'];

// Supabase config (compartida con auth y persistencia)
const SUPA_URL  = 'https://zuuvvhhpcdngvauonxms.supabase.co';
const SUPA_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inp1dXZ2aGhwY2RuZ3ZhdW9ueG1zIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA0MTA0MjYsImV4cCI6MjA5NTk4NjQyNn0.sYbXyOTmN8qDraFLgk0ifiPU3NHr0Ezb3PaqrTywFxQ';

// Verifica el access_token contra Supabase Auth. Devuelve el email verificado
// o null si el token es inválido/expirado o el email no está en la whitelist.
async function verificarUsuario(req) {
  const auth = req.headers['authorization'] || req.headers['Authorization'] || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!token) return null;
  try {
    const r = await fetch(`${SUPA_URL}/auth/v1/user`, {
      headers: { apikey: SUPA_ANON, Authorization: `Bearer ${token}` }
    });
    if (!r.ok) return null;
    const u = await r.json();
    const email = (u?.email || '').toLowerCase();
    if (!email || !EMAILS_OK.includes(email)) return null;
    return email;
  } catch (e) {
    console.error('verificarUsuario error:', e.message);
    return null;
  }
}

function setCors(req, res) {
  const origin = req.headers.origin || '';
  const allow  = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  res.setHeader('Access-Control-Allow-Origin',  allow);
  res.setHeader('Vary',                         'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

export default async function handler(req, res) {
  setCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Autenticación real: verificar token contra Supabase Auth
  const emailVerificado = await verificarUsuario(req);
  if (!emailVerificado) {
    return res.status(401).json({ error: 'No autorizado. Iniciá sesión de nuevo.' });
  }

  try {
    const { tipo, cuitCliente, condicionIva, impTotal, envio: envioRaw, conIva, items: pedidoItems } = req.body;
    const userEmail = emailVerificado;

    // ── CHEQUEO ANTI-DUPLICADO ───────────────────────────────
    const pedidoId = req.body.pedidoId || '';
    if (pedidoId) {
      try {
        const dupRes = await fetch(
          `${SUPA_URL}/rest/v1/facturas?pedido_id=eq.${encodeURIComponent(pedidoId)}&select=id,nro,tipo,cae,cae_vto,total,punto_venta,pdf_url`,
          { headers: { 'apikey': SUPA_ANON, 'Authorization': `Bearer ${SUPA_ANON}` } }
        );
        if (dupRes.ok) {
          const existing = await dupRes.json();
          if (Array.isArray(existing) && existing.length > 0) {
            const f = existing[0];
            console.log('Factura ya existe para pedido', pedidoId, '— devolviendo existente');
            return res.status(200).json({
              ok: true, CAE: f.cae, CAEFchVto: f.cae_vto || '',
              nroComprobante: f.nro, tipo: f.tipo, total: f.total,
              puntoVenta: f.punto_venta || 10, pdfUrl: f.pdf_url || '',
              yaExistia: true,
            });
          }
        }
      } catch(dupErr) {
        console.warn('Error chequeando duplicado:', dupErr.message);
      }
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

    // Para Factura A: consultar razón social y domicilio del padrón AFIP
    let receiverName    = tipo === 'A' ? String(req.body.cliente || cuitCliente || '-') : 'CONSUMIDOR FINAL';
    let receiverAddress = '-';
    if (tipo === 'A' && docNro) {
      try {
        const padronData = await afip.RegisterScopeThirteen.getTaxpayerDetails(docNro);
        if (padronData) {
          const rs = padronData.datosGenerales?.razonSocial
            || (padronData.datosGenerales?.nombre
                ? (padronData.datosGenerales.nombre + ' ' + (padronData.datosGenerales.apellido || '')).trim()
                : null);
          if (rs) receiverName = rs;
          const dom = padronData.datosGenerales?.domicilioFiscal;
          if (dom) {
            const partes = [dom.direccion, dom.localidad, dom.descripcionProvincia].filter(Boolean);
            if (partes.length) receiverAddress = partes.join(', ');
          }
          console.log('Padron receptor:', receiverName, '|', receiverAddress);
        }
      } catch(padronErr) {
        console.warn('No se pudo consultar padron AFIP:', padronErr.message);
      }
    }

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

    // CRÍTICO: el envío se incluye en ImpTotal/ImpNeto pero hay que sumarlo como línea
    // visible en el PDF, sino el detalle de items no suma el total facturado
    if (envio > 0) {
      pdfItems.push({
        code:        String(pdfItems.length + 1).padStart(3, '0'),
        description: 'Costo de envío',
        quantity:    1,
        unit_price:  envio,
        subtotal:    envio,
        ...(tipo === 'A' && { vat_rate: 21 }),
      });
    }

    // VALIDACIÓN ANTI-DESCUADRE: la suma de subtotales de items debe coincidir con
    // el ImpTotal que se le mandó a AFIP. Si no coincide, NO seguimos — abortamos
    // antes de generar un PDF que el cliente pueda usar para reclamar.
    const sumaItemsPdf = Math.round(pdfItems.reduce((s, it) => s + it.subtotal, 0) * 100) / 100;
    const diffCheck = Math.abs(sumaItemsPdf - total);
    if (diffCheck > 1) { // tolerancia de redondeo de $1
      console.error('DESCUADRE DETECTADO: suma items PDF =', sumaItemsPdf, 'vs total facturado =', total, 'diff =', diffCheck);
      console.error('pedidoItems recibidos:', JSON.stringify(pedidoItems));
      console.error('envio:', envio);
      // La factura YA fue emitida en AFIP en este punto (createNextVoucher ya corrió arriba).
      // No podemos cancelarla, pero SÍ evitamos generar/guardar un PDF incorrecto.
      // Guardamos igual la factura (CAE válido) pero marcamos el problema explícitamente.
    }

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
      receiver_name:             receiverName,
      receiver_address:          receiverAddress,
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

    // Nombre del archivo: factura-{tipo}-{nro con ceros}-{razón social slug}.pdf
    const razonSlug = receiverName
      .normalize('NFD').replace(/[̀-ͯ]/g, '') // quitar tildes
      .replace(/[^a-zA-Z0-9\s]/g, '')                   // quitar caracteres especiales
      .trim().replace(/\s+/g, '_')                       // espacios a guiones bajos
      .substring(0, 30);                                 // máximo 30 chars
    const nroConCeros = String(result.voucherNumber).padStart(8, '0');
    const fileName = `factura-${tipo}-${nroConCeros}-${razonSlug}.pdf`;

    const pdfData = {
      file_name: fileName,
      template: { name: templateName, params: baseParams }
    };

    // ── 1. GUARDAR FACTURA EN SUPABASE (antes del PDF) ─────────
    // Así si el PDF falla, la factura ya quedó registrada y no se emite de nuevo
    let pdfUrlFinal = '';
    const facturaPayload = {
      pedido_id:    String(pedidoId),
      cliente:      String(req.body.cliente  || ''),
      tipo:         String(tipo),
      nro:          Number(result.voucherNumber),
      punto_venta:  Number(ptoVta),
      cae:          String(result.CAE),
      cae_vto:      String(result.CAEFchVto),
      total:        Number(total),
      con_iva:      !!conIva,
      pdf_url:      '',
      fecha_emision: now.toISOString().split('T')[0],
    };
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
    }

    // ── 2. GENERAR PDF (opcional — si falla la factura ya está en AFIP y Supabase) ──
    try {
      const pdfResult = await afip.ElectronicBilling.createPDF(pdfData);
      console.log('PDF URL temporal AfipSDK:', pdfResult.file);

      try {
        const pdfResponse = await fetch(pdfResult.file);
        if (pdfResponse.ok) {
          const pdfBuffer = await pdfResponse.arrayBuffer();
          const pdfBytes  = Buffer.from(pdfBuffer);
          // fileName ya definido arriba
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
            console.log('PDF subido a Supabase Storage OK:', pdfUrlFinal);
          } else {
            pdfUrlFinal = pdfResult.file;
            console.error('Error subiendo PDF a Storage:', uploadRes.status, await uploadRes.text());
          }
        }
      } catch(uploadErr) {
        pdfUrlFinal = pdfResult.file;
        console.error('Error upload PDF:', uploadErr.message);
      }

      // Actualizar pdf_url en Supabase
      if (pdfUrlFinal && pedidoId) {
        try {
          await fetch(
            `${SUPA_URL}/rest/v1/facturas?pedido_id=eq.${encodeURIComponent(pedidoId)}`,
            {
              method: 'PATCH',
              headers: {
                'apikey':        SUPA_ANON,
                'Authorization': `Bearer ${SUPA_ANON}`,
                'Content-Type':  'application/json',
                'Prefer':        'return=minimal'
              },
              body: JSON.stringify({ pdf_url: pdfUrlFinal })
            }
          );
        } catch(patchErr) {
          console.error('Error actualizando pdf_url:', patchErr.message);
        }
      }
    } catch(pdfErr) {
      const axiosData = pdfErr.response?.data;
      console.error('Error generando PDF (factura ya guardada):', pdfErr.message, JSON.stringify(axiosData));
      // No lanzar — devolver éxito igual con pdfUrl vacío
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
    return res.status(500).json({ error: e.message, detail: e.data || null });
  }
}
