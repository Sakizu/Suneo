const path = require("path");
const fs = require("fs");
const { MITM_DIR } = require("../paths");
const { generateRootCA, loadRootCA, generateLeafCert, generateRootCA_EC, generateLeafCertEC } = require("./rootCA");

// Android/Termux helpers (ESM) — loaded defensively; a failed require degrades
// to non-Android behavior instead of crashing module load. NOTE: these files
// are CommonJS (also spawned as a plain-node process), so `import` is a
// syntax error here and the `@/` alias doesn't resolve outside the bundler —
// hence the relative require.
let _termux = null;
try { _termux = require("../../lib/termux"); } catch { _termux = null; }
const IS_ANDROID = _termux ? _termux.IS_ANDROID : process.platform === "android";
const hasBinary = _termux ? _termux.hasBinary : () => false;

/**
 * P-256 via openssl CLI on Android: node-forge has no P-256 API, and the
 * RSA-2048 *sync* keygen blocks the event loop per new SNI domain on phone
 * CPUs. openssl EC keygen takes ~50ms in a child process (off the loop).
 * Falls back to forge RSA-2048 when openssl is missing (slower, but works).
 *
 * hasBinary() spawns a subprocess — memoize it so the SNI hot path doesn't
 * pay a fork per new domain.
 */
let _ecOpensslCache = null;
function useEcOpenssl() {
  if (_ecOpensslCache === null) {
    _ecOpensslCache = IS_ANDROID && hasBinary("openssl");
  }
  return _ecOpensslCache;
}

/**
 * Generate Root CA certificate (one-time setup)
 * This replaces the old static wildcard cert approach
 */
function generateCert() {
  if (useEcOpenssl()) return generateRootCA_EC();
  return generateRootCA();
}

/**
 * Get certificate for a specific domain (dynamic generation)
 * Used by SNICallback in server.js
 */
function getCertForDomain(domain) {
  try {
    if (useEcOpenssl()) {
      const leafCert = generateLeafCertEC(domain);
      return {
        key: leafCert.key,
        cert: leafCert.cert
      };
    }
    const rootCA = loadRootCA();
    const leafCert = generateLeafCert(domain, rootCA);
    return {
      key: leafCert.key,
      cert: leafCert.cert
    };
  } catch (error) {
    console.error(`Failed to generate cert for ${domain}:`, error.message);
    return null;
  }
}

module.exports = { generateCert, getCertForDomain };
