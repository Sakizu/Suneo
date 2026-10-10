const fs = require("fs");
const crypto = require("crypto");
const { exec, execFileSync } = require("child_process");
const { execWithPassword, isSudoAvailable } = require("../dns/dnsConfig.js");
const { runElevatedPowerShell, quotePs } = require("../winElevated.js");
const { log, err } = require("../logger");

// Android/Termux helpers (ESM) — loaded defensively; a failed require degrades
// to non-Android behavior instead of crashing module load. NOTE: these files
// are CommonJS (also spawned as a plain-node process), so `import` is a
// syntax error here and the `@/` alias doesn't resolve outside the bundler —
// hence the relative require.
let _termux = null;
try { _termux = require("../../lib/termux"); } catch { _termux = null; }
const IS_ANDROID = _termux ? _termux.IS_ANDROID : process.platform === "android";
const isRootedAndroid = _termux ? _termux.isRootedAndroid : () => false;
const runPrivileged = _termux ? _termux.runPrivileged : () => { throw new Error("runPrivileged unavailable"); };
const hasBinary = _termux ? _termux.hasBinary : () => false;

const IS_WIN = process.platform === "win32";
const IS_MAC = process.platform === "darwin";
const LINUX_CERT_PATHS = [
  // Debian / Ubuntu
  { dir: "/usr/local/share/ca-certificates", cmd: "update-ca-certificates" },
  // Arch Linux / CachyOS / Manjaro
  { dir: "/etc/ca-certificates/trust-source/anchors", cmd: "update-ca-trust" },
  // Fedora / RHEL / CentOS
  { dir: "/etc/pki/ca-trust/source/anchors", cmd: "update-ca-trust" },
  // openSUSE
  { dir: "/etc/pki/trust/anchors", cmd: "update-ca-certificates" }
];

function getLinuxCertConfig() {
  for (const config of LINUX_CERT_PATHS) {
    if (fs.existsSync(config.dir)) {
      return config;
    }
  }
  // Fallback to Debian default if none exist
  return LINUX_CERT_PATHS[0];
}
const ROOT_CA_CN = "Suneo MITM Root CA";

// Get SHA1 fingerprint from cert file using Node.js crypto
function getCertFingerprint(certPath) {
  const pem = fs.readFileSync(certPath, "utf-8");
  const der = Buffer.from(pem.replace(/-----[^-]+-----/g, "").replace(/\s/g, ""), "base64");
  return crypto.createHash("sha1").update(der).digest("hex").toUpperCase().match(/.{2}/g).join(":");
}

/**
 * Check if certificate is already installed in system store
 */
async function checkCertInstalled(certPath) {
  if (IS_WIN) return checkCertInstalledWindows(certPath);
  if (IS_MAC) return checkCertInstalledMac(certPath);
  if (IS_ANDROID) return checkCertInstalledAndroid(certPath);
  return checkCertInstalledLinux();
}

function checkCertInstalledMac(certPath) {
  return new Promise((resolve) => {
    try {
      const fingerprint = getCertFingerprint(certPath).replace(/:/g, "");
      // Verify exact cert bytes match — same CN with different fingerprint = stale cert
      exec(`security find-certificate -a -c "${ROOT_CA_CN}" -Z /Library/Keychains/System.keychain 2>/dev/null`, { windowsHide: true }, (error, stdout) => {
        if (error || !stdout) return resolve(false);
        const match = new RegExp(`SHA-1 hash:\\s*${fingerprint}`, "i").test(stdout);
        if (!match) return resolve(false);
        // Cert exists with matching fingerprint — confirm trust policy
        exec(`security verify-cert -c "${certPath}" -p ssl -k /Library/Keychains/System.keychain 2>/dev/null`, { windowsHide: true }, (err2) => {
          resolve(!err2);
        });
      });
    } catch {
      resolve(false);
    }
  });
}

function checkCertInstalledWindows(certPath) {
  return new Promise((resolve) => {
    // Check by SHA1 fingerprint — detects stale cert with same CN but different key
    let fingerprint;
    try {
      fingerprint = getCertFingerprint(certPath).replace(/:/g, "");
    } catch {
      return resolve(false);
    }
    exec(`certutil -store Root ${fingerprint}`, { windowsHide: true }, (error) => {
      resolve(!error);
    });
  });
}

/**
 * Install SSL certificate to system trust store
 */
async function installCert(sudoPassword, certPath) {
  if (!fs.existsSync(certPath)) {
    throw new Error(`Certificate file not found: ${certPath}`);
  }

  const isInstalled = await checkCertInstalled(certPath);
  if (isInstalled) {
    log("🔐 Cert: already trusted ✅");
    return;
  }

  if (IS_WIN) {
    await installCertWindows(certPath);
  } else if (IS_MAC) {
    await installCertMac(sudoPassword, certPath);
  } else if (IS_ANDROID) {
    await installCertAndroid(certPath);
  } else {
    await installCertLinux(sudoPassword, certPath);
  }
}

async function installCertMac(sudoPassword, certPath) {
  // Remove all old certs with same name first to avoid duplicate/stale cert conflict
  const deleteOld = `security delete-certificate -c "${ROOT_CA_CN}" /Library/Keychains/System.keychain 2>/dev/null || true`;
  const install = `security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain "${certPath}"`;
  try {
    await execWithPassword(`${deleteOld} && ${install}`, sudoPassword);
    log("🔐 Cert: ✅ installed to system keychain");
  } catch (error) {
    const msg = error.message?.includes("canceled") ? "User canceled authorization" : "Certificate install failed";
    throw new Error(msg);
  }
}

async function installCertWindows(certPath) {
  // Auto-elevate via UAC popup if not admin (zero popup if already admin).
  // Delete any stale cert with same CN before adding to avoid duplicates.
  const script = `
    certutil -delstore Root ${quotePs(ROOT_CA_CN)} 2>$null | Out-Null
    $exit = & certutil -addstore Root ${quotePs(certPath)} 2>&1
    if ($LASTEXITCODE -ne 0) { throw "certutil exit $LASTEXITCODE" }
  `;
  try {
    await runElevatedPowerShell(script);
    log("🔐 Cert: ✅ installed to Windows Root store");
  } catch (e) {
    throw new Error(`Failed to install certificate: ${e.message}`);
  }
}

/**
 * Uninstall SSL certificate from system store
 */
async function uninstallCert(sudoPassword, certPath) {
  const isInstalled = await checkCertInstalled(certPath);
  if (!isInstalled) {
    log("🔐 Cert: not found in system store");
    return;
  }

  if (IS_WIN) {
    await uninstallCertWindows();
  } else if (IS_MAC) {
    await uninstallCertMac(sudoPassword, certPath);
  } else if (IS_ANDROID) {
    await uninstallCertAndroid(certPath);
  } else {
    await uninstallCertLinux(sudoPassword);
  }
}

async function uninstallCertMac(sudoPassword, certPath) {
  const fingerprint = getCertFingerprint(certPath).replace(/:/g, "");
  const command = `security delete-certificate -Z "${fingerprint}" /Library/Keychains/System.keychain`;
  try {
    await execWithPassword(command, sudoPassword);
    log("🔐 Cert: ✅ uninstalled from system keychain");
  } catch (err) {
    throw new Error("Failed to uninstall certificate");
  }
}

async function uninstallCertWindows() {
  // Auto-elevate via UAC popup if not admin
  const script = `certutil -delstore Root ${quotePs(ROOT_CA_CN)}`;
  try {
    await runElevatedPowerShell(script);
    log("🔐 Cert: ✅ uninstalled from Windows Root store");
  } catch (e) {
    throw new Error(`Failed to uninstall certificate: ${e.message}`);
  }
}

function checkCertInstalledLinux() {
  const config = getLinuxCertConfig();
  const certFile = `${config.dir}/9router-root-ca.crt`;
  return Promise.resolve(fs.existsSync(certFile));
}

// ── Android (rooted) system trust store ───────────────────────────────────
// Android keeps system CAs in /system/etc/security/cacerts/<hash>.0 where
// <hash> is the LEGACY OpenSSL subject hash (openssl x509 -subject_hash_old),
// NOT the modern -hash output. There is no update-ca-certificates / security /
// certutil here — installation is a privileged file copy.

function getAndroidCaHashFilename(certPath) {
  if (!hasBinary("openssl")) {
    throw new Error("CA install on Android needs the openssl binary (Termux: pkg install openssl) to derive the <hash>.0 filename");
  }
  let hash;
  try {
    hash = execFileSync("openssl", ["x509", "-subject_hash_old", "-noout", "-in", certPath], { encoding: "utf8" }).trim();
  } catch (e) {
    throw new Error(`Failed to derive Android CA hash filename: ${e.message}`);
  }
  if (!/^[0-9a-f]{8}$/.test(hash)) {
    throw new Error(`Unexpected openssl hash output for CA filename: ${hash}`);
  }
  return `${hash}.0`;
}

function checkCertInstalledAndroid(certPath) {
  try {
    const destName = getAndroidCaHashFilename(certPath);
    return Promise.resolve(fs.existsSync(`/system/etc/security/cacerts/${destName}`));
  } catch {
    return Promise.resolve(false);
  }
}

async function installCertAndroid(certPath) {
  if (!isRootedAndroid()) {
    throw new Error("Installing the MITM CA into the Android system trust store requires root (su). Grant root to Termux and retry.");
  }
  const destName = getAndroidCaHashFilename(certPath);
  const dest = `/system/etc/security/cacerts/${destName}`;
  // Best-effort /system remount (read-write). On Magisk with the
  // "Systemless Hosts"/CA modules this is unnecessary; on rooted stock /
  // userdebug it makes the copy possible. SELinux label restore is best-effort.
  const cmd = [
    "mount -o remount,rw /system 2>/dev/null || true",
    `cp "${certPath}" "${dest}"`,
    `chmod 644 "${dest}"`,
    `chcon u:object_r:system_file:s0 "${dest}" 2>/dev/null || true`,
    "mount -o remount,ro /system 2>/dev/null || true",
  ].join(" && ");
  try {
    runPrivileged(cmd);
  } catch (e) {
    throw new Error(`Android CA install failed — /system may not be writable (consider a Magisk CA-cert module): ${e.message}`);
  }
  // NOTE (M6): no NSS-DB injection on Android — desktop Firefox/Chromium
  // profile databases don't exist here; the system store is authoritative.
  log(`🔐 Cert: ✅ installed to Android system trust store (${dest}). A reboot may be required on some ROMs.`);
}

async function uninstallCertAndroid(certPath) {
  if (!isRootedAndroid()) return;
  let destName;
  try {
    destName = getAndroidCaHashFilename(certPath);
  } catch {
    return;
  }
  try {
    runPrivileged(
      `mount -o remount,rw /system 2>/dev/null || true; rm -f "/system/etc/security/cacerts/${destName}"; mount -o remount,ro /system 2>/dev/null || true`
    );
    log("🔐 Cert: ✅ uninstalled from Android system trust store");
  } catch (e) {
    throw new Error(`Failed to uninstall Android CA: ${e.message}`);
  }
}

async function updateNssDatabases(certPath, action = 'add') {
  // M6: desktop Firefox/Chromium NSS profile injection is meaningless on
  // Android — the system trust store (see installCertAndroid) is authoritative.
  if (IS_ANDROID) return;
  const certName = "Suneo MITM Root CA";
  
  const script = `
    if ! command -v certutil &> /dev/null; then
      exit 0
    fi
    
    DIRS="$HOME/.pki/nssdb $HOME/snap/chromium/current/.pki/nssdb"
    
    if [ -d "$HOME/.mozilla/firefox" ]; then
      for profile in "$HOME"/.mozilla/firefox/*/; do
        if [ -f "\${profile}cert9.db" ] || [ -f "\${profile}cert8.db" ]; then
          DIRS="$DIRS $profile"
        fi
      done
    fi

    if [ -d "$HOME/snap/firefox/common/.mozilla/firefox" ]; then
      for profile in "$HOME"/snap/firefox/common/.mozilla/firefox/*/; do
        if [ -f "\${profile}cert9.db" ] || [ -f "\${profile}cert8.db" ]; then
          DIRS="$DIRS $profile"
        fi
      done
    fi

    for db in $DIRS; do
      if [ -d "$db" ]; then
        if [ "${action}" = "add" ]; then
          certutil -d sql:"$db" -A -t "C,," -n "${certName}" -i "${certPath}" 2>/dev/null || \\
          certutil -d "$db" -A -t "C,," -n "${certName}" -i "${certPath}" 2>/dev/null || true
        else
          certutil -d sql:"$db" -D -n "${certName}" 2>/dev/null || \\
          certutil -d "$db" -D -n "${certName}" 2>/dev/null || true
        fi
      fi
    done
  `;
  
  return new Promise((resolve) => {
    exec(script, { shell: "/bin/bash" }, () => resolve());
  });
}

async function installCertLinux(sudoPassword, certPath) {
  if (!isSudoAvailable()) {
    log(`🔐 Cert: cannot install to system store without sudo — trust this file on clients: ${certPath}`);
    // Still try to update user NSS DBs even if no sudo!
    await updateNssDatabases(certPath, 'add');
    return;
  }
  
  const config = getLinuxCertConfig();
  const destFile = `${config.dir}/9router-root-ca.crt`;
  
  // Copy to the discovered directory and execute the specific update command
  const cmd = `cp "${certPath}" "${destFile}" && (${config.cmd} 2>/dev/null || true)`;
  
  try {
    await execWithPassword(cmd, sudoPassword);
    await updateNssDatabases(certPath, 'add');
    log(`🔐 Cert: ✅ installed to Linux trust store (${config.dir}) and user browser databases`);
  } catch (error) {
    throw new Error(`Certificate install failed: ${error.message}`);
  }
}

async function uninstallCertLinux(sudoPassword) {
  // Always try to uninstall from user DBs even without sudo
  await updateNssDatabases(null, 'delete');

  if (!isSudoAvailable()) {
    return;
  }
  
  const config = getLinuxCertConfig();
  const destFile = `${config.dir}/9router-root-ca.crt`;
  const cmd = `rm -f "${destFile}" && (${config.cmd} 2>/dev/null || true)`;
  
  try {
    await execWithPassword(cmd, sudoPassword);
    log("🔐 Cert: ✅ uninstalled from Linux trust store and user browser databases");
  } catch (error) {
    throw new Error("Failed to uninstall certificate");
  }
}

module.exports = { installCert, uninstallCert, checkCertInstalled };
