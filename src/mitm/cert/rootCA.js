const path = require("path");
const fs = require("fs");
const os = require("os");
const { execFileSync } = require("child_process");
const forge = require("node-forge");
const { MITM_DIR } = require("../paths");

const ROOT_CA_KEY_PATH = path.join(MITM_DIR, "rootCA.key");
const ROOT_CA_CERT_PATH = path.join(MITM_DIR, "rootCA.crt");

/**
 * Check if cert file is expired or expiring within 30 days
 */
function isCertExpired(certPath) {
  try {
    const cert = forge.pki.certificateFromPem(fs.readFileSync(certPath, "utf8"));
    const expiryThreshold = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    return cert.validity.notAfter < expiryThreshold;
  } catch {
    return true; // treat unreadable cert as expired
  }
}

/**
 * Generate Root CA certificate (only once, auto-regenerate if expired)
 * This Root CA will sign all dynamic leaf certificates
 */
function generateRootCA() {
  const exists = fs.existsSync(ROOT_CA_KEY_PATH) && fs.existsSync(ROOT_CA_CERT_PATH);
  if (exists && !isCertExpired(ROOT_CA_CERT_PATH)) {
    console.log("✅ Root CA already exists");
    return { key: ROOT_CA_KEY_PATH, cert: ROOT_CA_CERT_PATH };
  }
  if (exists) {
    console.log("🔐 Root CA expired or expiring soon — regenerating...");
    try { fs.unlinkSync(ROOT_CA_KEY_PATH); } catch { /* ignore */ }
    try { fs.unlinkSync(ROOT_CA_CERT_PATH); } catch { /* ignore */ }
  }

  if (!fs.existsSync(MITM_DIR)) {
    fs.mkdirSync(MITM_DIR, { recursive: true });
  }

  console.log("🔐 Generating Root CA certificate...");

  // Generate RSA key pair
  const keys = forge.pki.rsa.generateKeyPair(2048);

  // Create Root CA certificate
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = "01";
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date();
  cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 10);

  const attrs = [
    { name: "commonName", value: "Suneo MITM Root CA" },
    { name: "organizationName", value: "Suneo" },
    { name: "countryName", value: "US" }
  ];

  cert.setSubject(attrs);
  cert.setIssuer(attrs); // Self-signed

  cert.setExtensions([
    {
      name: "basicConstraints",
      cA: true,
      critical: true
    },
    {
      name: "keyUsage",
      keyCertSign: true,
      cRLSign: true,
      critical: true
    },
    {
      name: "subjectKeyIdentifier"
    }
  ]);

  // Self-sign the certificate
  cert.sign(keys.privateKey, forge.md.sha256.create());

  // Save to disk
  const privateKeyPem = forge.pki.privateKeyToPem(keys.privateKey);
  const certPem = forge.pki.certificateToPem(cert);

  // Ensure MITM_DIR exists (first run has no mitm/ yet)
  fs.mkdirSync(path.dirname(ROOT_CA_KEY_PATH), { recursive: true });
  fs.writeFileSync(ROOT_CA_KEY_PATH, privateKeyPem);
  fs.writeFileSync(ROOT_CA_CERT_PATH, certPem);

  console.log("✅ Root CA generated successfully");
  return { key: ROOT_CA_KEY_PATH, cert: ROOT_CA_CERT_PATH };
}

/**
 * Load Root CA from disk
 */
function loadRootCA() {
  if (!fs.existsSync(ROOT_CA_KEY_PATH) || !fs.existsSync(ROOT_CA_CERT_PATH)) {
    throw new Error("Root CA not found. Generate it first.");
  }

  const keyPem = fs.readFileSync(ROOT_CA_KEY_PATH, "utf8");
  const certPem = fs.readFileSync(ROOT_CA_CERT_PATH, "utf8");

  return {
    key: forge.pki.privateKeyFromPem(keyPem),
    cert: forge.pki.certificateFromPem(certPem)
  };
}

/**
 * Generate leaf certificate for a specific domain, signed by Root CA
 */
function generateLeafCert(domain, rootCA) {
  // Generate key pair for leaf cert
  const keys = forge.pki.rsa.generateKeyPair(2048);

  // Create leaf certificate
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = Math.floor(Math.random() * 1000000).toString();
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date();
  cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 1);

  cert.setSubject([
    { name: "commonName", value: domain }
  ]);

  cert.setIssuer(rootCA.cert.subject.attributes);

  cert.setExtensions([
    {
      name: "basicConstraints",
      cA: false
    },
    {
      name: "keyUsage",
      digitalSignature: true,
      keyEncipherment: true
    },
    {
      name: "extKeyUsage",
      serverAuth: true,
      clientAuth: true
    },
    {
      name: "subjectAltName",
      altNames: [
        { type: 2, value: domain }, // DNS
        { type: 2, value: `*.${domain}` } // Wildcard
      ]
    }
  ]);

  // Sign with Root CA
  cert.sign(rootCA.key, forge.md.sha256.create());

  return {
    key: forge.pki.privateKeyToPem(keys.privateKey),
    cert: forge.pki.certificateToPem(cert)
  };
}

module.exports = {
  generateRootCA,
  loadRootCA,
  generateLeafCert,
  isCertExpired,
  generateRootCA_EC,
  generateLeafCertEC,
  ROOT_CA_CERT_PATH,
  ROOT_CA_KEY_PATH
};

// ── EC P-256 via openssl CLI (Android fast path) ──────────────────────────
// node-forge exposes no P-256 API, so on Android — where the RSA-2048 sync
// keygen stalls the event loop per new SNI domain — we shell out to openssl:
// native speed (~50ms) and fully off the event loop (child process).
// Callers must gate on IS_ANDROID + openssl presence and fall back to the
// forge RSA functions above when openssl is missing.

function openssl(args) {
  return execFileSync("openssl", args, { encoding: "utf8", timeout: 60000 });
}

/**
 * Generate Root CA (EC P-256, self-signed, 10y). Mirrors generateRootCA()'s
 * reuse-if-valid behavior; returns { key, cert } PATHS like the RSA version.
 */
function generateRootCA_EC() {
  const exists = fs.existsSync(ROOT_CA_KEY_PATH) && fs.existsSync(ROOT_CA_CERT_PATH);
  if (exists && !isCertExpired(ROOT_CA_CERT_PATH)) {
    console.log("✅ Root CA already exists");
    return { key: ROOT_CA_KEY_PATH, cert: ROOT_CA_CERT_PATH };
  }
  if (exists) {
    console.log("🔐 Root CA expired or expiring soon — regenerating...");
    try { fs.unlinkSync(ROOT_CA_KEY_PATH); } catch { /* ignore */ }
    try { fs.unlinkSync(ROOT_CA_CERT_PATH); } catch { /* ignore */ }
  }

  if (!fs.existsSync(MITM_DIR)) {
    fs.mkdirSync(MITM_DIR, { recursive: true });
  }

  console.log("🔐 Generating Root CA certificate (EC P-256)...");

  openssl([
    "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1",
    "-keyout", ROOT_CA_KEY_PATH, "-out", ROOT_CA_CERT_PATH,
    "-days", "3650", "-nodes",
    "-subj", "/CN=Suneo MITM Root CA/O=Suneo/C=US",
    "-addext", "basicConstraints=critical,CA:TRUE",
    "-addext", "keyUsage=critical,keyCertSign,cRLSign",
    "-addext", "subjectKeyIdentifier=hash",
  ]);
  try { fs.chmodSync(ROOT_CA_KEY_PATH, 0o600); } catch { /* best effort */ }

  console.log("✅ Root CA generated successfully");
  return { key: ROOT_CA_KEY_PATH, cert: ROOT_CA_CERT_PATH };
}

/**
 * Generate leaf certificate (EC P-256) for a domain, signed by the on-disk
 * Root CA. openssl handles RSA or EC CA keys transparently, so a pre-existing
 * RSA root CA keeps working. Returns { key, cert } PEM STRINGS like the RSA
 * version (matches what server.js SNICallback expects).
 */
function generateLeafCertEC(domain) {
  const safeDomain = String(domain).replace(/[^a-zA-Z0-9.*-]/g, "");
  if (!safeDomain) throw new Error(`Invalid domain for cert: ${domain}`);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "9r-leaf-"));
  try {
    const keyPath = path.join(tmp, "leaf.key");
    const csrPath = path.join(tmp, "leaf.csr");
    const extPath = path.join(tmp, "leaf.ext");
    const certPath = path.join(tmp, "leaf.crt");

    openssl(["ecparam", "-genkey", "-name", "prime256v1", "-noout", "-out", keyPath]);
    openssl(["req", "-new", "-key", keyPath, "-out", csrPath, "-subj", `/CN=${safeDomain}`]);
    fs.writeFileSync(extPath,
      `subjectAltName=DNS:${safeDomain},DNS:*.${safeDomain}\n` +
      "basicConstraints=CA:FALSE\n" +
      "keyUsage=digitalSignature,keyEncipherment\n" +
      "extendedKeyUsage=serverAuth,clientAuth\n");
    openssl(["x509", "-req", "-in", csrPath,
      "-CA", ROOT_CA_CERT_PATH, "-CAkey", ROOT_CA_KEY_PATH, "-CAcreateserial",
      "-out", certPath, "-days", "365", "-sha256", "-extfile", extPath]);

    return {
      key: fs.readFileSync(keyPath, "utf8"),
      cert: fs.readFileSync(certPath, "utf8")
    };
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}
