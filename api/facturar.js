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
    const neto    = base;

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
      ImpOpEx:   0,
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

    return res.status(200).json({
      ok:             true,
      CAE:            result.CAE,
      CAEFchVto:      result.CAEFchVto,
      nroComprobante: result.voucherNumber,
      tipo,
      total,
      puntoVenta: ptoVta,
    });

  } catch (e) {
    console.error('Error facturar:', e.message, e.data || '');
    return res.status(500).json({ error: e.message, detail: e.data || null });
  }
}
