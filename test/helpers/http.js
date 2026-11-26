import http from 'node:http';

export function request(port, { method = 'GET', path: reqPath = '/', headers = {}, body = null, host } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      method,
      path: reqPath,
      setHost: false,
      headers: { Host: host ?? `127.0.0.1:${port}`, Connection: 'close', ...headers },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        const text = buf.toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* not JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json, buf });
      });
    });
    req.on('error', reject);
    if (body !== null) req.write(body);
    req.end();
  });
}

export function postJson(port, reqPath, obj, headers = {}) {
  return request(port, {
    method: 'POST',
    path: reqPath,
    headers: { 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${port}`, ...headers },
    body: JSON.stringify(obj),
  });
}
