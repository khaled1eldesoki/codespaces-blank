'use strict';
// Private certificate authority for the laboratory LAN (no internet, no OpenSSL, no PowerShell needed).
//  - ca.crt / ca.key      : the EDCL CA (10 years). ca.crt is copied to every client PC. ca.key NEVER leaves the server.
//  - server.crt / server.key : the server certificate signed by the CA (2 years), valid for every name/IP clients use.
// When the server certificate expires or the server's name/IP changes, re-issue it with `cli.js make-certs --renew`;
// clients keep working because they trust the CA, not the individual server certificate.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const forge = require('node-forge');
const pki = forge.pki;

const serial = () => '01' + crypto.randomBytes(15).toString('hex');
const fp = pem => crypto.createHash('sha256').update(new crypto.X509Certificate(pem).raw).digest('hex').toUpperCase().match(/../g).join(':');
const isIp = s => /^\d{1,3}(\.\d{1,3}){3}$/.test(s) || /^[0-9a-f:]+$/i.test(s) && s.includes(':');

function makeCA(commonName = 'EDCL Laboratory CA', years = 10) {
  const keys = pki.rsa.generateKeyPair({ bits: 2048, e: 0x10001 });
  const c = pki.createCertificate();
  c.publicKey = keys.publicKey; c.serialNumber = serial();
  c.validity.notBefore = new Date(Date.now() - 24 * 3600e3); c.validity.notAfter = new Date(Date.now() + years * 365 * 24 * 3600e3);
  const a = [{ name: 'commonName', value: commonName }, { name: 'organizationName', value: 'Egyptian Doping Control Laboratory' }, { name: 'countryName', value: 'EG' }];
  c.setSubject(a); c.setIssuer(a);
  c.setExtensions([{ name: 'basicConstraints', cA: true, pathLenConstraint: 0, critical: true }, { name: 'keyUsage', keyCertSign: true, cRLSign: true, critical: true }, { name: 'subjectKeyIdentifier' }]);
  c.sign(keys.privateKey, forge.md.sha256.create());
  return { cert: pki.certificateToPem(c), key: pki.privateKeyToPem(keys.privateKey) };
}
function makeServerCert(ca, { names = [], ips = [], days = 730 } = {}) {
  const caCert = pki.certificateFromPem(ca.cert), caKey = pki.privateKeyFromPem(ca.key);
  const dns = [...new Set(names.map(s => String(s).trim()).filter(s => s && !isIp(s)).map(s => s.toLowerCase()))];
  const ip = [...new Set([...ips.map(s => String(s).trim()).filter(isIp), '127.0.0.1'])];
  if (!dns.includes('localhost')) dns.push('localhost');
  const cn = dns.find(d => d !== 'localhost') || ip[0] || 'edcl-server';
  const keys = pki.rsa.generateKeyPair({ bits: 2048, e: 0x10001 });
  const c = pki.createCertificate();
  c.publicKey = keys.publicKey; c.serialNumber = serial();
  c.validity.notBefore = new Date(Date.now() - 24 * 3600e3);
  c.validity.notAfter = new Date(Math.min(Date.now() + days * 24 * 3600e3, caCert.validity.notAfter.getTime() - 24 * 3600e3));
  c.setSubject([{ name: 'commonName', value: cn }, { name: 'organizationName', value: 'Egyptian Doping Control Laboratory' }]);
  c.setIssuer(caCert.subject.attributes);
  c.setExtensions([
    { name: 'basicConstraints', cA: false, critical: true },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
    { name: 'extKeyUsage', serverAuth: true },
    { name: 'subjectAltName', altNames: [...dns.map(v => ({ type: 2, value: v })), ...ip.map(v => ({ type: 7, ip: v }))] },
    { name: 'authorityKeyIdentifier', keyIdentifier: caCert.generateSubjectKeyIdentifier().getBytes() }
  ]);
  c.sign(caKey, forge.md.sha256.create());
  return { cert: pki.certificateToPem(c), key: pki.privateKeyToPem(keys.privateKey), dns, ip, notAfter: c.validity.notAfter.toISOString() };
}
// outDir gets: ca.crt ca.key server.crt server.key  (+ client-config/ca.crt, client-config/server.json when a url is given)
function make({ outDir, names = [], ips = [], days = 730, renew = false, url = '' }) {
  fs.mkdirSync(outDir, { recursive: true });
  const P = f => path.join(outDir, f);
  let ca;
  if (fs.existsSync(P('ca.crt')) && fs.existsSync(P('ca.key'))) {
    if (!renew) throw new Error('Certificates already exist in ' + outDir + '. Use --renew to issue a new server certificate with the existing CA.');
    ca = { cert: fs.readFileSync(P('ca.crt'), 'utf8'), key: fs.readFileSync(P('ca.key'), 'utf8') };
    for (const f of ['server.crt', 'server.key']) if (fs.existsSync(P(f))) fs.copyFileSync(P(f), P(f + '.old-' + Date.now()));
  } else { ca = makeCA(); fs.writeFileSync(P('ca.crt'), ca.cert); fs.writeFileSync(P('ca.key'), ca.key, { mode: 0o600 }); }
  const s = makeServerCert(ca, { names, ips, days });
  fs.writeFileSync(P('server.crt'), s.cert); fs.writeFileSync(P('server.key'), s.key, { mode: 0o600 });
  const info = { caFingerprint: fp(ca.cert), serverFingerprint: fp(s.cert), dns: s.dns, ip: s.ip, serverNotAfter: s.notAfter };
  fs.writeFileSync(P('cert-info.json'), JSON.stringify(info, null, 2));
  if (url) {
    const cc = P('client-config'); fs.mkdirSync(cc, { recursive: true });
    fs.writeFileSync(path.join(cc, 'ca.crt'), ca.cert);
    fs.writeFileSync(path.join(cc, 'server.json'), JSON.stringify({ serverUrl: url, caFingerprint: info.caFingerprint }, null, 2));
  }
  return info;
}
// true when `leafPem` was issued by `caPem` and is currently valid (used by the desktop app to trust the lab CA without touching the Windows store)
function verifyChain_(leafPem, caPem) {
  const leaf = new crypto.X509Certificate(leafPem), ca = new crypto.X509Certificate(caPem), now = Date.now();
  return leaf.verify(ca.publicKey) && leaf.checkIssued(ca) && now >= Date.parse(leaf.validFrom) && now <= Date.parse(leaf.validTo);
}
module.exports = { make, makeCA, makeServerCert, fp, verifyChain: require('./certs-verify').verifyChain };
