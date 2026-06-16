import forge from 'node-forge';

const CUIT      = process.env.AFIP_CUIT;
const CERT_RAW  = process.env.AFIP_CERT || '';
const KEY_RAW   = process.env.AFIP_KEY  || '';
const EMAILS_OK = ['juliandilullo@gmail.com', 'sof.cosen@gmail.com'];
const WSAA_URL  = 'https://wsaa.afip.gov.ar/ws/services/LoginCms';
const WSFE_URL  = 'https://servicios1.afip.gov.ar/wsfev1/service.asmx';

function xmlEscape(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
function getTag(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`));
  return m ? m[1].trim() : '';
}
function getTags(xml, tag) {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'g');
  const r = []; let m;
  while ((m = re.exec(xml)) !== null) r.push(m[1].trim());
  return r;
}

function buildTRA() {
  const now  = new Date();
  const from = new Date(now.getTime() - 60000);
  const to   = new Date(now.getTime() + 600000);
  const fmt  = d => d.toISOString().replace(/\.\d+Z$/, '-03:00');
  return `<?xml version="1.0" encoding="UTF-8"?>
<loginTicketRequest version="1.0">
  <header>
    <uniqueId>${Date.now()}</uniqueId>
    <generationTime>${fmt(from)}</generationTime>
    <expirationTime>${fmt(to)}</expirationTime>
  </header>
  <service>wsfe</service>
</loginTicketRequest>`;
}

function signTRA(traXml, certPem, keyPem) {
  const cert       = forge.pki.certificateFromPem(certPem);
  const privateKey = forge.pki.privateKeyFromPem(keyPem);

  const p7 = forge.pkcs7.createSignedData();
  p7.content = forge.util.createBuffer(traXml, 'utf8');
  p7.addCertificate(cert);
  p7.addSigner({
    key:         privateKey,
    certificate: cert,
    digestAlgorithm: forge.pki.oids.sha256,
    authenticatedAttributes: [
      { type: forge.pki.oids.contentType,   value: forge.pki.oids.data },
      { type: forge.pki.oids.messageDigest },
      { type: forge.pki.oids.signingTime,   value: new Date() }
    ]
  });
  p7.sign();

  const der = forge.asn1.toDer(p7.toAsn1()).getBytes();
  return forge.util.encode64(der);
}

async function getTA(cert, key) {
  const tra    = buildTRA();
  const signed = signTRA(tra, cert, key);

  const soap = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:wsaa="http://wsaa.view.sua.dvadac.desein.afip.gov.ar">
  <soapenv:Header/>
  <soapenv:Body>
    <wsaa:loginCms><wsaa:in0>${signed}</wsaa:in0></wsaa:loginCms>
  </soapenv:Body>
</soapenv:Envelope>`;

  const r   = await fetch(WSAA_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/xml;charset=utf-8', 'SOAPAction': '"loginCms"' },
    body: soap
  });
  const xml = await r.text();
  console.log('WSAA response:', xml.substring(0, 500));

  const ret   = getTag(xml, 'loginCmsReturn');
  const token = getTag(ret, 'token');
  const sign  = getTag(ret, 'sign');
  if (!token) throw new Error('WSAA sin token. Resp: ' + xml.substring(0, 400));
  return { token, sign };
}

async function ultimoComprobante(token, sign, ptoVta, cbteTipo) {
  const soap = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ar="http://ar.gov.afip.dif.FEV1/">
  <soapenv:Header/>
  <soapenv:Body>
    <ar:FECompUltimoAutorizado>
      <ar:Auth><ar:Token>${xmlEscape(token)}</ar:Token><ar:Sign>${xmlEscape(sign)}</ar:Sign><ar:Cuit>${CUIT}</ar:Cuit></ar:Auth>
      <ar:PtoVta>${ptoVta}</ar:PtoVta><ar:CbteTipo>${cbteTipo}</ar:CbteTipo>
    </ar:FECompUltimoAutorizado>
  </soapenv:Body>
</soapenv:Envelope>`;
  const r   = await fetch(WSFE_URL, { method:'POST', headers:{'Content-Type':'text/xml;charset=utf-8','SOAPAction':''}, body: soap });
  const xml = await r.text();
  console.log('UltimoComprobante:', xml.substring(0, 300));
  return parseInt(getTag(xml, 'CbteNro')) || 0;
}

async function solicitarCAE(token, sign, ptoVta, cbteTipo, nro, docTipo, docNro, total, ivaAmt, neto, condIvaId, fecha) {
  const ivaXml = ivaAmt > 0
    ? `<ar:Iva><ar:AlicIva><ar:Id>5</ar:Id><ar:BaseImp>${neto.toFixed(2)}</ar:BaseImp><ar:Importe>${ivaAmt.toFixed(2)}</ar:Importe></ar:AlicIva></ar:Iva>`
    : '';
  const soap = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ar="http://ar.gov.afip.dif.FEV1/">
  <soapenv:Header/>
  <soapenv:Body>
    <ar:FECAESolicitar>
      <ar:Auth><ar:Token>${xmlEscape(token)}</ar:Token><ar:Sign>${xmlEscape(sign)}</ar:Sign><ar:Cuit>${CUIT}</ar:Cuit></ar:Auth>
      <ar:FeCAEReq>
        <ar:FeCabReq><ar:CantReg>1</ar:CantReg><ar:PtoVta>${ptoVta}</ar:PtoVta><ar:CbteTipo>${cbteTipo}</ar:CbteTipo></ar:FeCabReq>
        <ar:FeDetReq>
          <ar:FECAEDetRequest>
            <ar:Concepto>1</ar:Concepto>
            <ar:DocTipo>${docTipo}</ar:DocTipo><ar:DocNro>${docNro}</ar:DocNro>
            <ar:CbteDesde>${nro}</ar:CbteDesde><ar:CbteHasta>${nro}</ar:CbteHasta>
            <ar:CbteFch>${fecha}</ar:CbteFch>
            <ar:ImpTotal>${total.toFixed(2)}</ar:ImpTotal>
            <ar:ImpTotConc>0.00</ar:ImpTotConc>
            <ar:ImpNeto>${neto.toFixed(2)}</ar:ImpNeto>
            <ar:ImpOpEx>0.00</ar:ImpOpEx>
            <ar:ImpIVA>${ivaAmt.toFixed(2)}</ar:ImpIVA>
            <ar:ImpTrib>0.00</ar:ImpTrib>
            <ar:MonId>PES</ar:MonId><ar:MonCotiz>1</ar:MonCotiz>
            <ar:CondicionIVAReceptorId>${condIvaId}</ar:CondicionIVAReceptorId>
            ${ivaXml}
          </ar:FECAEDetRequest>
        </ar:FeDetReq>
      </ar:FeCAEReq>
    </ar:FECAESolicitar>
  </soapenv:Body>
</soapenv:Envelope>`;
  const r   = await fetch(WSFE_URL, { method:'POST', headers:{'Content-Type':'text/xml;charset=utf-8','SOAPAction':''}, body: soap });
  const xml = await r.text();
  console.log('FECAESolicitar:', xml.substring(0, 600));
  return xml;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { tipo, cuitCliente, condicionIva, impTotal, conIva, userEmail } = req.body;
    if (!EMAILS_OK.includes(userEmail)) return res.status(403).json({ error: 'No autorizado' });

    const CERT = CERT_RAW.replace(/\\n/g, '\n').trim();
    const KEY  = KEY_RAW.replace(/\\n/g, '\n').trim();
    console.log('CERT ok:', CERT.startsWith('-----BEGIN CERTIFICATE'));
    console.log('KEY ok:', KEY.startsWith('-----BEGIN RSA PRIVATE KEY') || KEY.startsWith('-----BEGIN PRIVATE KEY'));

    const ptoVta    = 10;
    const base      = parseFloat(impTotal);
    const ivaAmt    = conIva ? Math.round(base * 21) / 100 : 0;
    const total     = Math.round((base + ivaAmt) * 100) / 100;
    const neto      = base;
    const cbteTipo  = tipo === 'A' ? 1 : 6;
    const condMap   = { RI:1, EX:4, CF:5, MONO:6 };
    const condIvaId = condMap[condicionIva] || 5;
    const docTipo   = tipo === 'A' ? 80 : 99;
    const docNro    = tipo === 'A' ? parseInt((cuitCliente||'').replace(/[-]/g,'')) : 0;
    const fecha     = new Date().toISOString().split('T')[0].replace(/-/g,'');

    const { token, sign } = await getTA(CERT, KEY);
    const lastNro  = await ultimoComprobante(token, sign, ptoVta, cbteTipo);
    const nextNro  = lastNro + 1;
    console.log('Next nro:', nextNro);

    const caeXml   = await solicitarCAE(token, sign, ptoVta, cbteTipo, nextNro, docTipo, docNro, total, ivaAmt, neto, condIvaId, fecha);
    const resultado = getTag(caeXml, 'Resultado');
    if (resultado !== 'A') {
      const msgs = getTags(caeXml, 'Msg');
      throw new Error('AFIP rechazó: ' + (msgs.join(', ') || resultado || 'sin detalle'));
    }

    return res.status(200).json({
      ok: true,
      CAE:           getTag(caeXml, 'CAE'),
      CAEFchVto:     getTag(caeXml, 'CAEFchVto'),
      nroComprobante: nextNro,
      tipo, total, puntoVenta: ptoVta
    });

  } catch(e) {
    console.error('Error:', e.message);
    return res.status(500).json({ error: e.message });
  }
}
