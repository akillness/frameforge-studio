import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, closeSync, constants, fsyncSync, linkSync as linkKey, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { HttpError } from './validation.mjs';

// Names are application-owned identifiers, never paths or caller-provided filenames.
const NAME = /^[a-z][a-z0-9_-]{0,159}$/i;
const MAX_BYTES = 8 * 1024 * 1024;
const unavailable = () => new HttpError(503, 'Private runtime storage is unavailable or corrupt');

/** Private operational state shared by OAuth and resumable publication. Construction and
 * absent reads do not create directories or keys. Corruption never resets credentials. */
export class PrivateRuntime {
  constructor({ dataDir, tokenKey } = {}) {
    if (typeof dataDir !== 'string' || !dataDir) throw new TypeError('PrivateRuntime requires dataDir');
    this.root = path.join(path.resolve(dataDir), '.private');
    this.keyPath = path.join(this.root, 'key.bin');
    this.key = null;
    if (tokenKey !== undefined && tokenKey !== null) {
      if (Buffer.isBuffer(tokenKey) && tokenKey.length) this.key = tokenKey.length === 32 ? Buffer.from(tokenKey) : createHash('sha256').update(tokenKey).digest();
      else if (typeof tokenKey === 'string' && tokenKey) this.key = /^[a-f0-9]{64}$/i.test(tokenKey) ? Buffer.from(tokenKey, 'hex') : createHash('sha256').update(tokenKey).digest();
      else throw new TypeError('PrivateRuntime tokenKey must be a nonempty string or Buffer');
    }
  }

  _file(name) {
    if (typeof name !== 'string' || !NAME.test(name)) throw new HttpError(400, 'Invalid private runtime name');
    return path.join(this.root, `${name}.json`);
  }

  _root(create = false) {
    if (create) mkdirSync(this.root, { recursive: true, mode: 0o700 });
    try {
      const info = lstatSync(this.root);
      if (!info.isDirectory() || info.isSymbolicLink()) throw unavailable();
      if (create) chmodSync(this.root, 0o700);
      return true;
    } catch (error) {
      if (!create && error.code === 'ENOENT') return false;
      throw unavailable();
    }
  }

  _bytes(file) {
    const info = lstatSync(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_BYTES) throw unavailable();
    const descriptor = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    try { return readFileSync(descriptor); } finally { closeSync(descriptor); }
  }

  _key(create = false) {
    if (this.key) return this.key;
    try {
      const key = this._bytes(this.keyPath);
      if (key.length !== 32) throw unavailable();
      return key;
    } catch (error) {
      if (error.code !== 'ENOENT' || !create) throw unavailable();
      if (readdirSync(this.root).some((name) => name.endsWith('.json') || name.endsWith('.claimed'))) throw unavailable();
      const key = randomBytes(32);
      // Publish a complete key atomically, without replacing a competing install's key.
      const temporary = path.join(this.root, `key-${randomUUID()}.tmp`);
      try {
        const descriptor = openSync(temporary, 'wx', 0o600);
        try { writeFileSync(descriptor, key); fsyncSync(descriptor); } finally { closeSync(descriptor); }
        // Exclusive hard link makes the initialized key visible only after it is complete.
        linkKey(temporary, this.keyPath);
      } catch (failure) {
        if (failure.code !== 'EEXIST') throw unavailable();
      } finally { try { unlinkSync(temporary); } catch {} }
      const stored = this._bytes(this.keyPath);
      if (stored.length !== 32) throw unavailable();
      return stored;
    }
  }

  _decode(name, file) {
    const envelope = JSON.parse(this._bytes(file).toString('utf8'));
    if (envelope.v !== 1 || typeof envelope.iv !== 'string' || typeof envelope.tag !== 'string' || typeof envelope.data !== 'string') throw unavailable();
    const iv = Buffer.from(envelope.iv, 'base64');
    const tag = Buffer.from(envelope.tag, 'base64');
    if (iv.length !== 12 || tag.length !== 16) throw unavailable();
    const decipher = createDecipheriv('aes-256-gcm', this._key(), iv);
    decipher.setAAD(Buffer.from(name));
    decipher.setAuthTag(tag);
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.data, 'base64')), decipher.final()]).toString('utf8'));
  }

  read(name, fallback = null) {
    const file = this._file(name);
    try {
      if (!this._root()) return fallback;
      // Only a missing record returns the fallback; a missing key is corruption.
      try { lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
      return this._decode(name, file);
    } catch { throw unavailable(); }
  }

  write(name, value) {
    const file = this._file(name);
    let temporary;
    try {
      this._root(true);
      try {
        const info = lstatSync(file);
        if (!info.isFile() || info.isSymbolicLink()) throw unavailable();
        this._decode(name, file);
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', this._key(true), iv);
      cipher.setAAD(Buffer.from(name));
      const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
      const envelope = JSON.stringify({ v: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') });
      if (Buffer.byteLength(envelope) > MAX_BYTES) throw unavailable();
      temporary = path.join(this.root, `${name}-${randomUUID()}.tmp`);
      const descriptor = openSync(temporary, 'wx', 0o600);
      try { writeFileSync(descriptor, envelope); fsyncSync(descriptor); } finally { closeSync(descriptor); }
      renameSync(temporary, file);
      chmodSync(file, 0o600);
    } catch { throw unavailable(); }
    finally { if (temporary) { try { unlinkSync(temporary); } catch {} } }
  }

  remove(name) {
    const file = this._file(name);
    try {
      if (!this._root()) return;
      const info = lstatSync(file);
      if (!info.isFile() || info.isSymbolicLink()) throw unavailable();
      unlinkSync(file);
    } catch (error) { if (error.code !== 'ENOENT') throw unavailable(); }
  }

  /** Atomic one-use claim for OAuth callbacks, including simultaneous processes. */
  consume(name) {
    const file = this._file(name);
    const claimed = path.join(this.root, `${name}.claimed`);
    let descriptor;
    let completed = false;
    try {
      if (!this._root()) return null;
      // A shared exclusive name elects one consumer before anyone opens the record.
      // Renaming to random destinations can claim the same opened identity on Windows.
      try { descriptor = openSync(claimed, 'wx', 0o600); } catch (error) { if (error.code === 'EEXIST') return null; throw error; }
      fsyncSync(descriptor);
      try { lstatSync(file); } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        completed = true;
        return null;
      }
      const value = this._decode(name, file);
      unlinkSync(file);
      completed = true;
      return value;
    } catch { throw unavailable(); }
    finally {
      if (descriptor !== undefined) {
        try { closeSync(descriptor); } catch {}
        // A crash or uncertain failure retains the claim; never recover it automatically.
        if (completed) { try { unlinkSync(claimed); } catch {} }
      }
    }
  }
}

