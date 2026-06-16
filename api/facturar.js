const CERT = process.env.AFIP_CERT;
const KEY = process.env.AFIP_KEY;
const CUIT = process.env.AFIP_CUIT;
const ACCESS_TOKEN = process.env.AFIP_ACCESS_TOKEN;

const EMAILS_PERMITIDOS = ['juliandilullo@gmail.com', 'sof.cosen@gmail.com'];

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { tipo, cuitCliente, condicionIva, impTotal, conIva, puntoVenta, pedidoId, userEmail } = req.body;

    if (!EMAILS_PERMITIDOS.includes(userEmail)) {
      return res.status(403).json({ error: 'Usuario no autorizado' });
    }
    if (!tipo || !impTotal || !puntoVenta) {
      return res.status(400).json({ error: 'Faltan campos requeridos' });
    }
    if (tipo === 'A' && !cuitCliente) {
      return res.status(400).json({ error: 'CUIT del cliente requerido para Factura A' });
    }

    const base = parseFloat(impTotal);
    const ivaAmt = conIva ? Math.round(base * 0.21 * 100) / 100 : 0;
    const total = Math.round((base + ivaAmt) * 100) / 100;
    const neto = conIva ? Math.round(base * 100) / 100 : total;
    const cbteTipo = tipo === 'A' ? 1 : 6;
    const condicionIvaMap = { 'RI': 1, 'EX': 4, 'CF': 5, 'MONO': 6 };
    const condicionIvaId = condicionIvaMap[condicionIva] || 5;
    const docTipo = tipo === 'A' ? 80 : 99;
    const docNro = tipo === 'A' ? parseInt(cuitCliente.replace(/[-]/g, '')) : 0;
    const date = new Date().toISOString().split('T')[0].replace(/-/g, '');

    // Call AFIP SDK REST API
    const afipRes = await fetch('https://app.afipsdk.com/api/v1/afip/requests', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${ACCESS_TOKEN}`
      },
      body: JSON.stringify({
        environment: 1,
        method: 'FECAESolicitar',
        wsid: 'wsfe',
        cuit: CUIT,
        cert: CERT,
        key: KEY,
        params: {
          FeCAEReq: {
            FeCabReq: {
              CantReg: 1,
              PtoVta: parseInt(puntoVenta),
              CbteTipo: cbteTipo
            },
            FeDetReq: {
              FECAEDetRequest: [{
                Concepto: 1,
                DocTipo: docTipo,
                DocNro: docNro,
                CbteDesde: null,
                CbteHasta: null,
                CbteFch: parseInt(date),
                ImpTotal: total,
                ImpTotConc: 0,
                ImpNeto: neto,
                ImpOpEx: 0,
                ImpIVA: ivaAmt,
                ImpTrib: 0,
                MonId: 'PES',
                MonCotiz: 1,
                CondicionIVAReceptorId: condicionIvaId,
                Iva: conIva ? { AlicIva: [{ Id: 5, BaseImp: neto, Importe: ivaAmt }] } : undefined
              }]
            }
          }
        }
      })
    });

    const afipData = await afipRes.json();
    console.log('AFIP response:', JSON.stringify(afipData).substring(0, 500));

    if (!afipRes.ok || afipData.error) {
      throw new Error(afipData.error?.message || afipData.message || 'Error en AFIP SDK');
    }

    const detResp = afipData?.result?.FeDetResp?.FECAEDetResponse?.[0];
    if (!detResp || detResp.Resultado !== 'A') {
      const obs = detResp?.Observaciones?.Obs?.map(o => o.Msg).join(', ') || 'Error desconocido';
      throw new Error('AFIP rechazó la factura: ' + obs);
    }

    return res.status(200).json({
      ok: true,
      CAE: detResp.CAE,
      CAEFchVto: detResp.CAEFchVto,
      nroComprobante: detResp.CbteDesde,
      tipo,
      total,
      puntoVenta
    });

  } catch(e) {
    console.error('Error facturación:', e.message);
    return res.status(500).json({ error: e.message || 'Error al facturar' });
  }
}
