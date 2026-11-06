// @ts-check
'use strict';

// A small ZIP reader and writer for skill bundles (.skill and .zip files).
// Only what skill bundles need: stored and deflate entries, no encryption, no ZIP64.
// The reader never trusts the archive: sizes, counts and output lengths are capped,
// and every entry's CRC-32 is checked after it is unpacked.

const zlib = require('zlib');

class ZipError extends Error {}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** @param {Buffer} buf */
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** @param {Date} d */
function dosDateTime(d) {
  const year = Math.min(Math.max(d.getFullYear(), 1980), 2107);
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const date = ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

/**
 * Build a ZIP archive. Names use forward slashes; folders end with '/'.
 * @param {{ name: string, data?: Buffer, mtime?: Date }[]} entries
 * @returns {Buffer}
 */
function writeZip(entries) {
  /** @type {Buffer[]} */
  const chunks = [];
  /** @type {Buffer[]} */
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const isDir = e.name.endsWith('/');
    const name = Buffer.from(e.name, 'utf8');
    const data = isDir ? Buffer.alloc(0) : e.data || Buffer.alloc(0);
    const deflated = data.length ? zlib.deflateRawSync(data, { level: 9 }) : Buffer.alloc(0);
    const useDeflate = deflated.length < data.length;
    const body = useDeflate ? deflated : data;
    const crc = crc32(data);
    const { time, date } = dosDateTime(e.mtime || new Date(2026, 0, 1));
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(useDeflate ? 8 : 0, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, name, body);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE((3 << 8) | 20, 4); // made by: Unix, 2.0
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(useDeflate ? 8 : 0, 10);
    cd.writeUInt16LE(time, 12);
    cd.writeUInt16LE(date, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(body.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt16LE(0, 30); // extra
    cd.writeUInt16LE(0, 32); // comment
    cd.writeUInt16LE(0, 34); // disk
    cd.writeUInt16LE(0, 36); // internal attrs
    const mode = isDir ? 0o040755 : 0o100644;
    cd.writeUInt32LE(((mode << 16) | (isDir ? 0x10 : 0)) >>> 0, 38);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, name);
    offset += local.length + name.length + body.length;
  }
  const cdBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cdBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, cdBuf, end]);
}

const READ_LIMITS = Object.freeze({ maxEntries: 2000, maxBytes: 50 * 1024 * 1024 });

/**
 * @typedef {object} ZipEntry
 * @property {string} name      raw name from the archive (forward slashes)
 * @property {boolean} dir
 * @property {boolean} symlink
 * @property {number} size      uncompressed size
 * @property {() => Buffer} read unpacks and checks the CRC
 */

/**
 * List the entries of a ZIP archive held in memory.
 * @param {Buffer} buf
 * @param {typeof READ_LIMITS} [limits]
 * @returns {ZipEntry[]}
 */
function readZip(buf, limits = READ_LIMITS) {
  if (!Buffer.isBuffer(buf) || buf.length < 22) throw new ZipError('This is not a ZIP file (it is too short).');
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ZipError('This is not a ZIP file (no end record found).');
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdOffset === 0xffffffff) throw new ZipError('ZIP64 archives are not supported.');
  if (count > limits.maxEntries) throw new ZipError(`The archive has more than ${limits.maxEntries} entries.`);
  if (cdOffset + cdSize > eocd) throw new ZipError('The ZIP file is damaged (bad central directory).');
  /** @type {ZipEntry[]} */
  const out = [];
  let p = cdOffset;
  let total = 0;
  for (let i = 0; i < count; i++) {
    if (p + 46 > eocd || buf.readUInt32LE(p) !== 0x02014b50) throw new ZipError('The ZIP file is damaged (bad entry header).');
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28);
    const xlen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    const madeBy = buf.readUInt16LE(p + 4) >> 8;
    const ext = buf.readUInt32LE(p + 38);
    const lho = buf.readUInt32LE(p + 42);
    if (p + 46 + nlen > eocd) throw new ZipError('The ZIP file is damaged (bad entry name).');
    const name = buf.toString(flags & 0x0800 ? 'utf8' : 'latin1', p + 46, p + 46 + nlen).replace(/\\/g, '/');
    p += 46 + nlen + xlen + clen;
    const dir = name.endsWith('/');
    const mode = madeBy === 3 ? ext >>> 16 : 0;
    const symlink = (mode & 0o170000) === 0o120000;
    if (flags & 0x0001) throw new ZipError(`"${name}" is encrypted. Password-protected bundles are not supported.`);
    if (!dir && method !== 0 && method !== 8) throw new ZipError(`"${name}" uses compression method ${method}, which is not supported.`);
    if (csize === 0xffffffff || usize === 0xffffffff) throw new ZipError('ZIP64 archives are not supported.');
    total += usize;
    if (total > limits.maxBytes) throw new ZipError(`The archive unpacks to more than ${Math.round(limits.maxBytes / 1048576)} MB.`);
    const read = () => {
      if (lho + 30 > buf.length || buf.readUInt32LE(lho) !== 0x04034b50) throw new ZipError(`"${name}" is damaged (bad local header).`);
      const start = lho + 30 + buf.readUInt16LE(lho + 26) + buf.readUInt16LE(lho + 28);
      if (start + csize > buf.length) throw new ZipError(`"${name}" is damaged (data runs past the end).`);
      const raw = buf.subarray(start, start + csize);
      let data;
      if (method === 0) data = Buffer.from(raw);
      else {
        try {
          data = zlib.inflateRawSync(raw, { maxOutputLength: Math.max(usize, 1) });
        } catch {
          throw new ZipError(`"${name}" is damaged or larger than its header says.`);
        }
      }
      if (data.length !== usize || crc32(data) !== crc) throw new ZipError(`"${name}" is damaged (checksum mismatch).`);
      return data;
    };
    out.push({ name, dir, symlink, size: usize, read });
  }
  return out;
}

module.exports = { ZipError, crc32, writeZip, readZip, READ_LIMITS };
