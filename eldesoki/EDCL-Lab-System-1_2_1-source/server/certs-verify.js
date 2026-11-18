'use strict';
// Chain check used by the desktop app (no third-party code): leaf signed by the lab CA and currently valid.
const crypto = require('crypto');
function verifyChain(leafPem, caPem) {
  const leaf = new crypto.X509Certificate(leafPem), ca = new crypto.X509Certificate(caPem), now = Date.now();
  return leaf.verify(ca.publicKey) && leaf.checkIssued(ca) && now >= Date.parse(leaf.validFrom) && now <= Date.parse(leaf.validTo);
}
module.exports = { verifyChain };
