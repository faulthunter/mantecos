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
    const { tipo, cuitCliente, condicionIva, impTotal, conIva, userEmail } = req.body;

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

    // Calcular importes
    const base    = Math.round(parseFloat(impTotal) * 100) / 100;
    const ivaAmt  = conIva ? Math.round(base * 21) / 100 : 0;
    const total   = Math.round((base + ivaAmt) * 100) / 100;
    // Si no hay IVA: ImpNeto=0, ImpOpEx=base (exento). Si hay IVA: ImpNeto=base, ImpOpEx=0
    const neto    = conIva ? base : 0;
    const opEx    = conIva ? 0 : base;

    // Tipo de comprobante y receptor
    const cbteTipo  = tipo === 'A' ? 1 : 6;
    const docTipo   = tipo === 'A' ? 80 : 99;
    const docNro    = tipo === 'A' ? parseInt((cuitCliente || '').replace(/[-]/g, '')) : 0;

    // condicionIva → CondicionIVAReceptorId
    const condMap   = { RI: 1, EX: 4, CF: 5, MONO: 6 };
    const condIvaId = condMap[condicionIva] || 5;

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

    const pdfData = {
      file_name: `factura-${tipo}-${result.voucherNumber}.pdf`,
      template: {
        name: templateName,
        params: {
          voucher_number:            result.voucherNumber,
          sales_point:               ptoVta,
          issue_date:                fechaEmision,
          cae_due_date:              fechaVtoCae,
          issuer_cuit:               parseInt(CUIT),
          cae:                       parseInt(result.CAE),
          issuer_business_name:      'La Chica Manteca',
          issuer_address:            'Salta, Argentina',
          issuer_iva_condition:      'Responsable Inscripto',
          issuer_gross_income:       String(CUIT),
          issuer_activity_start_date:'01/01/2020',
          receiver_name:             tipo === 'A' ? (cuitCliente || '-') : 'CONSUMIDOR FINAL',
          receiver_address:          '-',
          receiver_document_type:    docTipo,
          receiver_document_number:  docNro,
          receiver_iva_condition:    condIvaStr[condicionIva] || 'Consumidor Final',
          sale_condition:            'Contado',
          currency_id:               'ARS',
          currency_rate:             1,
          concept:                   1,
          items: [
            {
              code:        '001',
              description: 'Productos de panadería artesanal',
              quantity:    1,
              unit_price:  total,
              subtotal:    total,
            }
          ],
          vat_amount:      ivaAmt,
          tributes_amount: 0,
          total_amount:    total,
          ...(tipo === 'A' && {
            net_amount_taxed:   neto,
            net_amount_untaxed: 0,
            exempt_amount:      opEx,
            vat_breakdown: ivaAmt > 0 ? [{ vat_rate_id: 21, taxable_base: neto, vat_subtotal: ivaAmt }] : [],
          }),
        }
      }
    };

    const pdfResult = await afip.ElectronicBilling.createPDF(pdfData);
    console.log('PDF URL:', pdfResult.file);

    return res.status(200).json({
      ok:             true,
      CAE:            result.CAE,
      CAEFchVto:      result.CAEFchVto,
      nroComprobante: result.voucherNumber,
      tipo,
      total,
      puntoVenta:     ptoVta,
      pdfUrl:         pdfResult.file,
    });

  } catch (e) {
    console.error('Error facturar:', e.message, e.data || '');
    return res.status(500).json({ error: e.message, detail: e.data || null });
  }
}
