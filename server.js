const express = require('express');
const crypto = require('crypto');
const { LRUCache } = require('lru-cache');
const fetch = require('node-fetch');

const PORT = process.env.PORT || 8080;
const SPLASH_URL = process.env.SPLASH_URL || 'http://localhost:8050';

const app = express();
app.use(express.raw({ type: '*/*', limit: '10mb' }));

const cache = new LRUCache({ max: 500, ttl: 1000 * 60 * 5 });

// ── ECDH key pair (auto-generated on startup, no secrets needed) ─────────────
const serverECDH = crypto.createECDH('prime256v1');
serverECDH.generateKeys();
const serverPubKeyB64 = serverECDH.getPublicKey('base64');
console.log('ECDH key pair generated automatically.');

function deriveAESKey(clientPubBuf) {
  const shared = serverECDH.computeSecret(clientPubBuf);
  return crypto.createHash('sha256').update(shared).digest();
}

// Request body: [65 bytes client pubkey] [12 bytes IV] [ciphertext] [16 bytes tag]
function decryptRequest(body) {
  if (body.length < 93) throw new Error('Payload too small');
  const clientPub = body.subarray(0, 65);
  const iv = body.subarray(65, 77);
  const tag = body.subarray(body.length - 16);
  const ct = body.subarray(77, body.length - 16);
  const key = deriveAESKey(clientPub);
  const dec = crypto.createDecipheriv('aes-256-gcm', key, iv);
  dec.setAuthTag(tag);
  const plain = Buffer.concat([dec.update(ct), dec.final()]);
  return { data: JSON.parse(plain.toString()), aesKey: key };
}

// Response body: [12 bytes IV] [ciphertext] [16 bytes tag]
function encryptResponse(obj, aesKey) {
  const plain = JSON.stringify(obj);
  const iv = crypto.randomBytes(12);
  const enc = crypto.createCipheriv('aes-256-gcm', aesKey, iv);
  const ct = Buffer.concat([enc.update(plain, 'utf8'), enc.final()]);
  return Buffer.concat([iv, ct, enc.getAuthTag()]);
}

function needsSplash(htmlStr, contentLength) {
  if (contentLength < 500) return true;
  if (htmlStr.includes('<div id="root"')) return true;
  if (htmlStr.includes('<div id="__next"')) return true;
  if (htmlStr.includes('You need to enable JavaScript')) return true;
  return false;
}

// ── CORS ─────────────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.header('Access-Control-Max-Age', '86400');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

app.get('/health', (req, res) => res.status(200).send('OK'));

// ── Public key endpoint (frontend fetches this once on load) ─────────────────
app.get('/api/pubkey', (req, res) => {
  res.json({ publicKey: serverPubKeyB64 });
});

// ── Proxy endpoint ───────────────────────────────────────────────────────────
app.post('/api/proxy', async (req, res) => {
  try {
    let requestObj, aesKey;
    try {
      const result = decryptRequest(req.body);
      requestObj = result.data;
      aesKey = result.aesKey;
    } catch (err) {
      console.error('Decryption error:', err.message);
      return res.status(400).send(`Decryption error: ${err.message}`);
    }

    const { method = 'GET', target, headers = {}, bodyBase64 } = requestObj;
    if (!target) return res.status(400).send('Target URL missing');

    const cacheKey = `${method}:${target}`;
    if (method === 'GET' && cache.has(cacheKey)) {
      const cached = cache.get(cacheKey);
      res.setHeader('Content-Type', 'application/octet-stream');
      return res.status(200).send(encryptResponse(cached, aesKey));
    }

    const fetchOpts = { method, headers: { ...headers }, redirect: 'follow' };
    delete fetchOpts.headers['host'];
    delete fetchOpts.headers['origin'];
    delete fetchOpts.headers['referer'];
    if (bodyBase64 && ['POST', 'PUT', 'PATCH'].includes(method)) {
      fetchOpts.body = Buffer.from(bodyBase64, 'base64');
    }

    let response, responseBodyBuffer, finalUrl, contentType;
    try {
      response = await fetch(target, fetchOpts);
      responseBodyBuffer = await response.buffer();
      finalUrl = response.url || target;
      contentType = response.headers.get('content-type') || 'application/octet-stream';
    } catch (err) {
      console.error('Fetch failed:', err.message);
      return res.status(502).send(`Fetch failed: ${err.message}`);
    }

    if (contentType.includes('text/html') && method === 'GET') {
      const htmlStr = responseBodyBuffer.toString('utf8');
      if (needsSplash(htmlStr, responseBodyBuffer.length)) {
        console.log(`[Splash] ${target}`);
        try {
          const splashRes = await fetch(
            `${SPLASH_URL}/render.html?url=${encodeURIComponent(target)}&wait=0.5`
          );
          if (splashRes.ok) {
            responseBodyBuffer = await splashRes.buffer();
            contentType = 'text/html';
          }
        } catch (err) {
          console.error('Splash failed:', err.message);
        }
      }
    }

    const responseHeaders = {};
    response.headers.forEach((v, k) => { responseHeaders[k] = v; });
    responseHeaders['content-type'] = contentType;

    // Strip frame-busting headers so content renders in the proxy iframe
    delete responseHeaders['x-frame-options'];
    delete responseHeaders['content-security-policy'];
    delete responseHeaders['content-security-policy-report-only'];

    const responseObj = {
      status: response.status,
      headers: responseHeaders,
      bodyBase64: responseBodyBuffer.toString('base64'),
      finalUrl,
    };

    if (method === 'GET' && responseObj.status === 200) cache.set(cacheKey, responseObj);

    res.setHeader('Content-Type', 'application/octet-stream');
    res.status(200).send(encryptResponse(responseObj, aesKey));
  } catch (err) {
    console.error('Proxy error:', err);
    res.status(500).send(`Proxy error: ${err.message}`);
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`CBP-Railway-Splash listening on port ${PORT}`);
});
