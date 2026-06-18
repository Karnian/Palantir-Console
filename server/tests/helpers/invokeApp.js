const { Duplex, Readable, Writable } = require('node:stream');

function lowerHeaders(headers = {}) {
  const out = {};
  for (const [key, value] of Object.entries(headers)) out[key.toLowerCase()] = value;
  return out;
}

function invokeApp(app, { method = 'GET', path = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    let sent = false;
    const req = new Readable({
      read() {
        if (payload) this.push(payload);
        this.push(null);
      },
    });
    req.method = method;
    req.url = path;
    req.originalUrl = path;
    req.headers = lowerHeaders({
      ...(payload ? { 'content-type': 'application/json', 'content-length': String(payload.length) } : {}),
      ...headers,
    });
    const socket = new Duplex({
      read() {},
      write(_chunk, _encoding, cb) { cb(); },
    });
    socket.encrypted = false;
    socket.remoteAddress = '127.0.0.1';
    req.socket = req.connection = socket;

    const chunks = [];
    const responseHeaders = {};
    const res = new Writable({
      write(chunk, encoding, cb) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding));
        cb();
      },
    });
    res.statusCode = 200;
    res.statusMessage = 'OK';
    res.setHeader = (key, value) => { responseHeaders[key.toLowerCase()] = value; return res; };
    res.getHeader = (key) => responseHeaders[key.toLowerCase()];
    res.getHeaders = () => ({ ...responseHeaders });
    res.removeHeader = (key) => { delete responseHeaders[key.toLowerCase()]; };
    res.writeHead = (statusCode, statusMessage, hdrs) => {
      res.statusCode = statusCode;
      if (typeof statusMessage === 'string') res.statusMessage = statusMessage;
      const headersArg = typeof statusMessage === 'object' && statusMessage !== null ? statusMessage : hdrs;
      for (const [key, value] of Object.entries(headersArg || {})) res.setHeader(key, value);
      return res;
    };
    Object.defineProperty(res, 'headersSent', { get: () => sent });
    const end = res.end.bind(res);
    res.end = (chunk, encoding, cb) => {
      sent = true;
      if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding));
      return end(cb);
    };
    res.on('finish', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      let parsed = {};
      try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = text; }
      resolve({ status: res.statusCode, headers: responseHeaders, text, body: parsed });
    });
    res.on('error', reject);
    try {
      app(req, res);
    } catch (err) {
      reject(err);
    }
  });
}

module.exports = { invokeApp };
