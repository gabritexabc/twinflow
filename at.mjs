// at.mjs — comunicação de documentos de transporte à Autoridade Tributária.
//
// SOURCES, and where this stops being sourced. Everything below comes from the AT's own
// "Manual de Integração de Software — Comunicação dos Documentos de Transporte à AT":
// the endpoints, the WS-Security scheme with its exact algorithms, the field names and
// their order, and the response codes. Two things could NOT be sourced, because the WSDL
// has moved from the address the manual gives and is no longer public:
//
//   1. the element that wraps the request body and its namespace
//   2. the element that carries the returned Código AT in the response
//
// Both are isolated in AT_CONTRACT below and overridable from the config file, so
// confirming them against the real WSDL is an edit to a JSON file, not to this code.
// They are the only guesses here and they are marked as such — everything else is
// quoted from the manual.
//
// Nothing in this module talks to the network unless communicate() is called, and
// communicate() refuses to run against production unless the config says so in as many
// words. A test movement sent to the live service becomes a really declared document.

import { randomBytes, publicEncrypt, createCipheriv, constants } from 'node:crypto';
import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import { readFileSync } from 'node:fs';

export const AT_ENDPOINTS = {
  test: 'https://servicos.portaldasfinancas.gov.pt:701/sgdtws/documentosTransporte',
  production: 'https://servicos.portaldasfinancas.gov.pt:401/sgdtws/documentosTransporte',
};

// The two unconfirmed names, and the namespace the 2013-era service used. Override from
// the AT config file once the WSDL is in hand.
export const AT_CONTRACT = {
  bodyNamespace: 'http://servicos.portaldasfinancas.gov.pt:701/sgdtws/documentosTransporte/',
  requestElement: 'envioDocumentoTransporteRequestElem',
  responseCodeElement: 'ReturnCode',
  responseAtCodeElement: 'ATDocCodeID',
};

const WSS_NS = 'http://schemas.xmlsoap.org/ws/2002/12/secext';
const SOAP_NS = 'http://schemas.xmlsoap.org/soap/envelope/';

const esc = (v) => String(v ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&apos;');

// ---------------------------------------------------------------- WS-Security
//
// Manual, section H:
//   K_S      a 128-bit AES key, generated per request and NEVER repeated
//   Nonce    Base64( RSA( K_S, AT public key ) )
//   Password Base64( AES-ECB-PKCS5( senha do Portal, K_S ) )
//   Created  Base64( AES-ECB-PKCS5( timestamp UTC ISO-8601, K_S ) )
//
// Java's "PKCS5Padding" on AES is PKCS#7 with a 16-byte block, which is what Node does by
// default — same padding, different name, and a place people lose an afternoon.
//
// RSA padding is the one algorithmic detail the manual leaves as just "RSA". PKCS#1 v1.5
// is what the AT's own Java sample uses and what every working client does; Node would
// otherwise default to OAEP, which the service rejects. Stated here because it is an
// assumption, not a quote.
export function buildSecurity({ username, password, atPublicKeyPem, now = new Date() }) {
  if (!username) throw new Error('AT: missing username (NIF/subutilizador)');
  if (!password) throw new Error('AT: missing Portal das Finanças password');
  if (!atPublicKeyPem) throw new Error('AT: missing the AT public key (atPublicKeyPath in the config)');

  const ks = randomBytes(16);
  const nonce = publicEncrypt(
    { key: atPublicKeyPem, padding: constants.RSA_PKCS1_PADDING },
    ks,
  ).toString('base64');

  const sym = (text) => {
    const c = createCipheriv('aes-128-ecb', ks, null);
    return Buffer.concat([c.update(String(text), 'utf8'), c.final()]).toString('base64');
  };

  // "A zona temporal deste campo deverá estar definida para UTC e formatado de acordo com
  // a norma ISO 8601" — the clock has to be right, the service validates it.
  const created = now.toISOString();

  return {
    username,
    passwordCipher: sym(password),
    nonce,
    createdCipher: sym(created),
    createdPlain: created,
  };
}

export function securityHeaderXml(sec) {
  return `<wss:Security xmlns:wss="${WSS_NS}">`
    + `<wss:UsernameToken>`
    + `<wss:Username>${esc(sec.username)}</wss:Username>`
    + `<wss:Password>${sec.passwordCipher}</wss:Password>`
    + `<wss:Nonce>${sec.nonce}</wss:Nonce>`
    + `<wss:Created>${sec.createdCipher}</wss:Created>`
    + `</wss:UsernameToken></wss:Security>`;
}

// ---------------------------------------------------------------- the document
//
// Field names and ORDER are the manual's (section 4.2, items 1.1 to 1.18). Order matters:
// an XSD sequence rejects the right elements in the wrong order, and that failure reads
// as a generic schema error.
//
// doc = {
//   senderNif, senderName, senderAddress: {detail, city, postalCode, country},
//   documentNumber, atDocCodeId?, movementStatus, movementDate, movementType,
//   customerNif?, supplierNif?, customerName?, customerAddress?,
//   addressTo?, addressFrom, movementEndTime?, movementStartTime, vehicleId?,
//   lines: [{ orderReferences?: [], description, quantity, unit, unitPrice }]
// }
const addressXml = (tag, a) => a ? `<${tag}>`
  + `<AddressDetail>${esc(a.detail)}</AddressDetail>`
  + `<City>${esc(a.city)}</City>`
  + `<PostalCode>${esc(a.postalCode)}</PostalCode>`
  + `<Country>${esc(a.country || 'PT')}</Country>`
  + `</${tag}>` : '';

// A recipient nobody knows is 999999990 — the manual's own placeholder, and the correct
// answer for a movement of the sender's own goods between their own places.
export const UNKNOWN_NIF = '999999990';

export function documentXml(doc) {
  const digits = (v) => String(v ?? '').replace(/\D/g, '');
  const num = (v) => Number(v || 0);
  const parts = [
    `<TaxRegistrationNumber>${digits(doc.senderNif)}</TaxRegistrationNumber>`,
    `<CompanyName>${esc(doc.senderName)}</CompanyName>`,
    addressXml('CompanyAddress', doc.senderAddress),
    `<DocumentNumber>${esc(doc.documentNumber)}</DocumentNumber>`,
    doc.atDocCodeId ? `<ATDocCodeID>${esc(doc.atDocCodeId)}</ATDocCodeID>` : '',
    `<MovementStatus>${esc(doc.movementStatus || 'N')}</MovementStatus>`,
    `<MovementDate>${esc(doc.movementDate)}</MovementDate>`,
    `<MovementType>${esc(doc.movementType)}</MovementType>`,
    doc.customerNif ? `<CustomerTaxID>${digits(doc.customerNif)}</CustomerTaxID>` : '',
    doc.supplierNif ? `<SupplierTaxID>${digits(doc.supplierNif)}</SupplierTaxID>` : '',
    doc.customerName ? `<CustomerName>${esc(doc.customerName)}</CustomerName>` : '',
    addressXml('CustomerAddress', doc.customerAddress),
    addressXml('AddressTo', doc.addressTo),
    addressXml('AddressFrom', doc.addressFrom),
    doc.movementEndTime ? `<MovementEndTime>${esc(doc.movementEndTime)}</MovementEndTime>` : '',
    `<MovementStartTime>${esc(doc.movementStartTime)}</MovementStartTime>`,
    doc.vehicleId ? `<VehicleID>${esc(doc.vehicleId)}</VehicleID>` : '',
    ...(doc.lines || []).map(l => `<Line>`
      + (l.orderReferences || []).map(r => `<OrderReferences>${esc(r)}</OrderReferences>`).join('')
      + `<ProductDescription>${esc(l.description)}</ProductDescription>`
      + `<Quantity>${num(l.quantity)}</Quantity>`
      + `<UnitOfMeasure>${esc(l.unit)}</UnitOfMeasure>`
      // "Em documentos não valorizados deve ser preenchido com 0.00" — which is this app:
      // it moves goods, it does not price them.
      + `<UnitPrice>${num(l.unitPrice).toFixed(2)}</UnitPrice>`
      + `</Line>`),
  ];
  return parts.filter(Boolean).join('');
}

export function envelopeXml({ security, doc, contract = AT_CONTRACT }) {
  return `<?xml version="1.0" encoding="UTF-8"?>`
    + `<S:Envelope xmlns:S="${SOAP_NS}">`
    + `<S:Header>${securityHeaderXml(security)}</S:Header>`
    + `<S:Body>`
    + `<${contract.requestElement} xmlns="${contract.bodyNamespace}">`
    + documentXml(doc)
    + `</${contract.requestElement}>`
    + `</S:Body></S:Envelope>`;
}

// ---------------------------------------------------------------- response
//
// ReturnCode 0 is success; anything else is a failure whose meaning is in the manual's
// table. Read by tag rather than by parsing the whole envelope: the response is small and
// the two values are unambiguous, and this avoids carrying an XML parser for four fields.
export function parseResponse(xml, contract = AT_CONTRACT) {
  // The lookahead is load-bearing. Without it `Username` also matches `UsernameToken`,
  // because [^>]* happily eats the rest of the name — the match then starts at the wrong
  // element and captures the opening tag as part of the value. Found by a test whose
  // expected value came back with a tag glued to the front of it.
  const tag = (name) => {
    const m = String(xml).match(new RegExp(`<(?:\\w+:)?${name}(?=[\\s/>])[^>]*>([\\s\\S]*?)</(?:\\w+:)?${name}>`, 'i'));
    return m ? m[1].trim() : null;
  };
  const codeRaw = tag(contract.responseCodeElement);
  const fault = tag('faultstring') || tag('Reason') || null;
  return {
    ok: codeRaw !== null && Number(codeRaw) === 0,
    returnCode: codeRaw === null ? null : Number(codeRaw),
    atDocCodeId: tag(contract.responseAtCodeElement),
    message: tag('ReturnMessage') || fault,
    fault,
    raw: String(xml),
  };
}

// ---------------------------------------------------------------- transport
//
// Mutual TLS: the AT signs a client certificate for the software producer and the
// connection presents it. Without it the service does not answer, which is why this
// throws a named error rather than a socket failure nobody can read.
export function loadAtMaterial(cfg) {
  const read = (p, what) => {
    if (!p) throw new Error(`AT: ${what} is not configured`);
    try { return readFileSync(p, 'utf8'); }
    catch { throw new Error(`AT: cannot read ${what} at ${p}`); }
  };
  // The client certificate is only needed for the real service; a plain-http override is
  // a stand-in, and demanding a certificate it will never check helps nobody.
  if (String(cfg?.endpointOverride || '').startsWith('http://')) {
    return { publicKey: read(cfg?.atPublicKeyPath, 'the AT public key (atPublicKeyPath)'), cert: null, key: null };
  }
  return {
    publicKey: read(cfg?.atPublicKeyPath, 'the AT public key (atPublicKeyPath)'),
    cert: read(cfg?.clientCertPath, 'the client certificate (clientCertPath)'),
    key: read(cfg?.clientKeyPath, 'the client private key (clientKeyPath)'),
  };
}

export function communicate({ cfg, security, doc, timeoutMs = 30000 }) {
  const production = cfg?.environment === 'production';
  // Inverted guard: reaching the live service takes an explicit word in the config, and
  // anything else — a typo, a missing field, a copied test file — lands on the test one.
  //
  // endpointOverride exists so this path can be exercised against a stand-in service, and
  // it is IGNORED in production. A test hook that can redirect live tax submissions is not
  // a test hook, it is a hole; the guard has to survive the thing added to test it.
  const endpoint = production
    ? AT_ENDPOINTS.production
    : (cfg?.endpointOverride || AT_ENDPOINTS.test);
  const material = loadAtMaterial(cfg);
  const contract = { ...AT_CONTRACT, ...(cfg?.contract || {}) };
  const body = envelopeXml({ security, doc, contract });
  const url = new URL(endpoint);

  const plain = url.protocol === 'http:'; // only reachable through endpointOverride
  const send = plain ? httpRequest : httpsRequest;
  return new Promise((resolve, reject) => {
    const req = send({
      host: url.hostname,
      port: url.port,
      path: url.pathname,
      method: 'POST',
      ...(plain ? {} : { cert: material.cert, key: material.key }),
      headers: {
        'Content-Type': 'text/xml; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
        SOAPAction: '',
      },
      timeout: timeoutMs,
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, production, endpoint, ...parseResponse(data, contract) }));
    });
    req.on('timeout', () => { req.destroy(new Error('AT: the service did not answer in time')); });
    req.on('error', reject);
    req.end(body);
  });
}
