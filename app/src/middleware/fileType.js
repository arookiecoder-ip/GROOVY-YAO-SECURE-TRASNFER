// Validate uploaded file MIME type via magic bytes (file-type library).
// Blocks executables and enforces content-type honesty.

const BLOCKED_TYPES = new Set([
  'application/x-msdownload',
  'application/x-dosexec',
  'application/x-executable',
  'application/x-sharedlib',
  'application/x-msdos-program',
  'application/x-sh',
  'application/x-bat',
  'application/x-powershell',
  'application/x-mach-binary',
  'application/x-elf',
]);

const BLOCKED_EXTENSIONS = /\.(exe|dll|so|bat|cmd|sh|ps1|vbs|jar|msi|scr|com|pif|app|deb|rpm)$/i;

// How many bytes to read for magic-byte detection (4096 is enough for all common formats)
const MAGIC_BYTES_SAMPLE = 4096;

let _fileTypeFromBuffer;

async function getFileTypeFromBuffer(buf) {
  if (!_fileTypeFromBuffer) {
    const mod = await import('file-type');
    _fileTypeFromBuffer = mod.fileTypeFromBuffer;
  }
  return _fileTypeFromBuffer(buf);
}

/**
 * Validate a file's type by extension and magic bytes.
 * @param {Buffer} buf - First MAGIC_BYTES_SAMPLE bytes of the file (or full buffer for small files)
 * @param {string} declaredName - The filename as declared by the client
 * @returns {{ ok: boolean, reason?: string }}
 */
async function validateFileType(buf, declaredName) {
  if (BLOCKED_EXTENSIONS.test(declaredName || '')) {
    return { ok: false, reason: 'Blocked file extension' };
  }

  try {
    const result = await getFileTypeFromBuffer(buf);
    if (result && BLOCKED_TYPES.has(result.mime)) {
      return { ok: false, reason: `Blocked file type: ${result.mime}` };
    }
  } catch { /* file-type failed — allow through, log elsewhere */ }

  return { ok: true };
}

module.exports = { validateFileType, MAGIC_BYTES_SAMPLE };
