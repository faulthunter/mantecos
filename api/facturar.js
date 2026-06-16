import Afip from '@afipsdk/afip.js';

const CERT = process.env.AFIP_CERT;
const KEY = process.env.AFIP_KEY;
const CUIT = process.env.AFIP_CUIT;
const ACCESS_TOKEN = process.env.AFIP_ACCESS_TOKEN;

// Allowed emails
const EMAILS_PERMITIDOS = ['juliandilullo@gmail.com', 'sof.cosen@gmail.com'];

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', 'https://mantecos.vercel.app');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { tipo, cuitCliente, condicionIva, impTotal, conIva, puntoVenta, pedidoId, userEmail } = req.body;

    // Validar email autorizado
    if (!EMAILS_PERMITIDOS.includes(userEmail)) {
      return res.status(403).json({ error: 'Usuario no autorizado' });
    }

    // Validar campos requeridos
    if (!tipo || !impTotal || !puntoVenta) {
      return res.status(400).json({ error: 'Faltan campos requeridos' });
    }
    if (tipo === 'A' && !cuitCliente) {
      return res.status(400).json({ error: 'CUIT del cliente requerido para Factura A' });
    }

    const afip = new Afip({
      CUIT,
      cert: CERT,
      key: KEY,
      access_token: ACCESS_TOKEN,
      production: true
    });

    // Calcular importes
    const base = parseFloat(impTotal);
    const ivaAmt = conIva ? Math.round(base * 0.21 * 100) / 100 : 0;
    const total = Math.round((base + ivaAmt) * 100) / 100;
    const neto = conIva ? Math.round(base * 100) / 100 : total;

    // Tipo de comprobante: 1=Factura A, 6=Factura B
    const cbteTipo = tipo === 'A' ? 1 : 6;

    // Condición IVA receptor
    // 1=IVA Responsable Inscripto, 4=IVA Sujeto Exento, 5=Consumidor Final, 6=Responsable Monotributo
    const condicionIvaMap = { 'RI': 1, 'EX': 4, 'CF': 5, 'MONO': 6 };
    const condicionIvaId = condicionIvaMap[condicionIva] || 5;

    // DocTipo: 80=CUIT, 99=consumidor final
    const docTipo = tipo === 'A' ? 80 : 99;
    const docNro = tipo === 'A' ? parseInt(cuitCliente.replace(/[-]/g, '')) : 0;

    const date = new Date(Date.now() - (new Date().getTimezoneOffset() * 60000))
      .toISOString().split('T')[0];

    const data = {
      CantReg: 1,
      PtoVta: parseInt(puntoVenta),
      CbteTipo: cbteTipo,
      Concepto: 1, // Productos
      DocTipo: docTipo,
      DocNro: docNro,
      CbteFch: parseInt(date.replace(/-/g, '')),
      ImpTotal: total,
      ImpTotConc: 0,
      ImpNeto: neto,
      ImpOpEx: 0,
      ImpIVA: ivaAmt,
      ImpTrib: 0,
      MonId: 'PES',
      MonCotiz: 1,
      CondicionIVAReceptorId: condicionIvaId,
    };

    if (conIva) {
      data.Iva = [{
        Id: 5, // 21%
        BaseImp: neto,
        Importe: ivaAmt
      }];
    }

    const result = await afip.ElectronicBilling.createNextVoucher(data);

    return res.status(200).json({
      ok: true,
      CAE: result.CAE,
      CAEFchVto: result.CAEFchVto,
      nroComprobante: result.voucher_number,
      tipo,
      total,
      puntoVenta
    });

  } catch (e) {
    console.error('Error facturación:', e);
    return res.status(500).json({ error: e.message || 'Error al facturar' });
  }
}
