const express = require('express');
const crypto = require('crypto');
const { LRUCache } = require('lru-cache');
const fetch = require('node-fetch');

const PORT = process.env.PORT || 8080;
const SECRET = process.env.SECRET;
const SPLASH_URL = process.env.SPLASH_URL || 'http://localhost:8050';

if (!SECRET) {
  console.error('FATAL: SECRET environment variable is not set.');
  process.exit(1);
}

const app = express();

// Use a raw body parser for the binary data
app.use(express.raw({ type: '*/*', limit: '10mb' }));

// LRU Cache: 5 minutes TTL, max 500 items
const cache = new LRUCache({
  max: 500,
  ttl: 1000 * 60 * 5,
});

// --- Encryption logic matching SubtleCrypto AES-GCM ---
function getEpoch() {
  return Math.floor(Date.now() / 600000);
}

function getKey(epoch) {
  return crypto.createHash('sha256').update(`${SECRET}:${epoch}`).digest();
}

function decryptObject(buffer, epoch) {
  if (buffer.length < 28) throw new Error('Buffer too small to contain IV, Ciphertext, and AuthTag');
  
  const iv = buffer.subarray(0, 12);
  const authTag = buffer.subarray(buffer.length - 16);
  const ciphertext = buffer.subarray(12, buffer.length - 16);
  
  const key = getKey(epoch);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  
  let decrypted = decipher.update(ciphertext);
  decrypted = Buffer.concat([decrypted, decipher.final()]);
  return JSON.parse(decrypted.toString('utf8'));
}

function encryptObject(obj, epoch) {
  const plain = JSON.stringify(obj);
  const key = getKey(epoch);
  const iv = crypto.randomBytes(12);
  
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  let encrypted = cipher.update(plain, 'utf8');
  encrypted = Buffer.concat([encrypted, cipher.final()]);
  const authTag = cipher.getAuthTag();
  
  // SubtleCrypto appends authTag to ciphertext
  return Buffer.concat([iv, encrypted, authTag]);
}

// --- Splash detection ---
function needsSplash(htmlStr, contentLength) {
  if (contentLength < 500) return true;
  if (htmlStr.includes('<div id="root"')) return true;
  if (htmlStr.includes('<div id="__next"')) return true;
  if (htmlStr.includes('You need to enable JavaScript')) return true;
  return false;
}

// --- CORS ---
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.header('Access-Control-Max-Age', '86400');
  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }
  next();
});

// --- Health Check ---
app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

// --- Proxy Endpoint ---
app.post('/api/proxy', async (req, res) => {
  try {
    const epoch = getEpoch();
    let requestObj;
    try {
      requestObj = decryptObject(req.body, epoch);
    } catch (err) {
      console.error('Decryption error:', err.message);
      return res.status(400).send(`Decryption error: ${err.message}`);
    }

    const { method = 'GET', target, headers = {}, bodyBase64 } = requestObj;

    if (!target) {
      return res.status(400).send('Target URL missing');
    }

    // Check cache
    const cacheKey = `${method}:${target}`;
    if (method === 'GET' && cache.has(cacheKey)) {
      const cachedResponse = cache.get(cacheKey);
      const encryptedResponse = encryptObject(cachedResponse, epoch);
      res.setHeader('Content-Type', 'application/octet-stream');
      return res.status(200).send(encryptedResponse);
    }

    // Prepare forward fetch
    const fetchOptions = {
      method,
      headers: { ...headers },
      redirect: 'follow',
    };
    
    // Strip forbidden headers
    delete fetchOptions.headers['host'];
    delete fetchOptions.headers['origin'];
    delete fetchOptions.headers['referer'];

    if (bodyBase64 && ['POST', 'PUT', 'PATCH'].includes(method)) {
      fetchOptions.body = Buffer.from(bodyBase64, 'base64');
    }

    let response;
    let responseBodyBuffer;
    let finalUrl;
    let contentType;

    try {
      response = await fetch(target, fetchOptions);
      responseBodyBuffer = await response.buffer();
      finalUrl = response.url || target;
      contentType = response.headers.get('content-type') || 'application/octet-stream';
    } catch (err) {
      console.error('Initial fetch failed:', err.message);
      return res.status(502).send(`Fetch failed: ${err.message}`);
    }

    const isHtml = contentType.includes('text/html');
    let useSplash = false;

    if (isHtml && method === 'GET') {
      const htmlStr = responseBodyBuffer.toString('utf8');
      if (needsSplash(htmlStr, responseBodyBuffer.length)) {
        useSplash = true;
      }
    }

    if (useSplash) {
      console.log(`[Splash] Falling back to Splash for ${target}`);
      const splashEndpoint = `${SPLASH_URL}/render.html?url=${encodeURIComponent(target)}&wait=0.5`;
      try {
        const splashRes = await fetch(splashEndpoint);
        if (splashRes.ok) {
          const splashHtml = await splashRes.buffer();
          responseBodyBuffer = splashHtml;
          contentType = 'text/html';
          // Splash might not give us the final URL of redirects as easily, but usually it's fine
        } else {
          console.error(`Splash error ${splashRes.status}`);
        }
      } catch (err) {
        console.error('Splash fetch failed:', err.message);
        // We will just fall back to the initial raw HTML if splash fails
      }
    }

    const responseHeaders = {};
    if (response) {
      response.headers.forEach((value, key) => {
        responseHeaders[key] = value;
      });
    }
    responseHeaders['content-type'] = contentType; // Override with possible Splash type

    const responseObj = {
      status: response ? response.status : 200,
      headers: responseHeaders,
      bodyBase64: responseBodyBuffer.toString('base64'),
      finalUrl: finalUrl
    };

    if (method === 'GET' && responseObj.status === 200) {
      cache.set(cacheKey, responseObj);
    }

    const encryptedResponse = encryptObject(responseObj, epoch);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.status(200).send(encryptedResponse);

  } catch (err) {
    console.error('Proxy internal error:', err);
    res.status(500).send(`Proxy error: ${err.message}`);
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`CBP-Railway-Splash Proxy listening on port ${PORT}`);
});
