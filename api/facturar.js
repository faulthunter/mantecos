const CUIT = process.env.AFIP_CUIT;
const ACCESS_TOKEN = process.env.AFIP_ACCESS_TOKEN;
const CERT_RAW = process.env.AFIP_CERT || '';
const KEY_RAW = process.env.AFIP_KEY || '';
const BASE_URL = 'https://app.afipsdk.com/api/v1';

const EMAILS_PERMITIDOS = ['juliandilullo@gmail.com', 'sof.cosen@gmail.com'];

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { tipo, cuitCliente, condicionIva, impTotal, conIva, puntoVenta, userEmail } = req.body;

    if (!EMAILS_PERMITIDOS.includes(userEmail)) {
      return res.status(403).json({ error: 'Usuario no autorizado' });
    }

    // Normalizar cert y key - reemplazar \n literal por saltos reales
    const CERT = CERT_RAW.replace(/\\n/g, '\n').trim();
    const KEY = KEY_RAW.replace(/\\n/g, '\n').trim();

    // Diagnóstico
    console.log('CERT starts:', CERT.substring(0, 30));
    console.log('CERT ends:', CERT.substring(CERT.length - 30));
    console.log('KEY starts:', KEY.substring(0, 30));
    console.log('CUIT:', CUIT);
    console.log('Has newlines cert:', CERT.includes('\n'));
    console.log('Has newlines key:', KEY.includes('\n'));

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

    const headers = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${ACCESS_TOKEN}`
    };

    // Paso 1: Último comprobante (usar PtoVta 10 - Factura Electronica RI Web Services)
    const ptoVta = 10;
    const lastRes = await fetch(`${BASE_URL}/afip/requests`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        environment: 'prod',
        tax_id: CUIT,
        wsid: 'wsfe',
        cert: CERT,
        key: KEY,
        method: 'FECompUltimoAutorizado',
        params: { PtoVta: ptoVta, CbteTipo: cbteTipo }
      })
    });
    const lastData = await lastRes.json();
    console.log('Last voucher:', JSON.stringify(lastData).substring(0, 300));
    if (lastData.error) throw new Error(lastData.error?.message || JSON.stringify(lastData.error));

    const lastRaw = lastData?.result || lastData;
    const lastNum = lastRaw?.FECompUltimoAutorizadoResult?.CbteNro ?? lastRaw?.CbteNro ?? 0;
    const nextNum = lastNum + 1;

    // Paso 2: Solicitar CAE
    const voucherData = {
      Concepto: 1, DocTipo: docTipo, DocNro: docNro,
      CbteDesde: nextNum, CbteHasta: nextNum,
      CbteFch: parseInt(date),
      ImpTotal: total, ImpTotConc: 0, ImpNeto: neto,
      ImpOpEx: 0, ImpIVA: ivaAmt, ImpTrib: 0,
      MonId: 'PES', MonCotiz: 1,
      CondicionIVAReceptorId: condicionIvaId
    };
    if (conIva) voucherData.Iva = { AlicIva: [{ Id: 5, BaseImp: neto, Importe: ivaAmt }] };

    const caeRes = await fetch(`${BASE_URL}/afip/requests`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        environment: 'prod',
        tax_id: CUIT,
        wsid: 'wsfe',
        cert: CERT,
        key: KEY,
        method: 'FECAESolicitar',
        params: {
          FeCAEReq: {
            FeCabReq: { CantReg: 1, PtoVta: ptoVta, CbteTipo: cbteTipo },
            FeDetReq: { FECAEDetRequest: [voucherData] }
          }
        }
      })
    });

    const caeData = await caeRes.json();
    console.log('CAE response:', JSON.stringify(caeData).substring(0, 800));
    if (caeData.error) throw new Error(caeData.error?.message || JSON.stringify(caeData.error).substring(0, 200));

    const raw = caeData?.result || caeData;
    const solResult = raw?.FECAESolicitarResult || raw;
    const detResp = solResult?.FeDetResp?.FECAEDetResponse?.[0];

    if (!detResp) {
      const errors = solResult?.Errors?.Err || solResult?.Events?.Evt;
      const msg = Array.isArray(errors) ? errors.map(e => e.Msg).join(', ') : JSON.stringify(solResult).substring(0, 200);
      throw new Error(msg);
    }
    if (detResp.Resultado !== 'A') {
      const obs = detResp?.Observaciones?.Obs;
      const errores = detResp?.Errores?.Err;
      const msgObs = Array.isArray(obs) ? obs.map(o => o.Msg).join(', ') : (obs?.Msg || '');
      const msgErr = Array.isArray(errores) ? errores.map(e => e.Msg).join(', ') : (errores?.Msg || '');
      throw new Error('AFIP rechazó: ' + (msgErr || msgObs || detResp.Resultado));
    }

    return res.status(200).json({
      ok: true, CAE: detResp.CAE, CAEFchVto: detResp.CAEFchVto,
      nroComprobante: nextNum, tipo, total, puntoVenta
    });

  } catch(e) {
    console.error('Error facturación:', e.message);
    return res.status(500).json({ error: e.message });
  }
}
