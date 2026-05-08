# cbp-railway-splash

This is a customized Node.js backend for the `trynProxy` frontend, specifically designed to be deployed on Railway's free tier. 

It replaces the original Cloudflare Worker backend by implementing the exact same AES-256-GCM WebCrypto protocol for secure, end-to-end encrypted proxying.

## Features
- **Splash Integration**: Uses the `scrapinghub/splash` Docker image to render JavaScript-heavy pages without timing out.
- **Unified Container**: A single Dockerfile spins up both Splash (on port 8050) and the Node.js Express proxy, making it trivial to deploy on Railway without multi-service configurations.
- **LRU Caching**: Caches successful renders for 5 minutes to improve performance on repeated requests.
- **Drop-in Replacement**: Expects the exact same encrypted binary POST requests as the Cloudflare worker (`{ method, target, headers, bodyBase64 }`).

## Deployment Instructions

### Deploy to Railway
1. Create a new project in Railway and select **Deploy from GitHub repo**.
2. Select this repository.
3. Railway will automatically detect the `Dockerfile` and build it.
4. Go to the **Variables** tab for the service and add your proxy secret:
   ```env
   SECRET=your-secret-key-here
   ```

### Update Frontend
In your frontend deployment (Vercel/Cloudflare Pages), update the environment variable to point to your new Railway URL:
```env
VITE_WORKER_URL=https://your-railway-app-url.up.railway.app
```
*Note: Make sure your frontend's `SECRET` exactly matches the `SECRET` variable set in Railway.*

## Local Development
To run locally, you need Docker installed:
```bash
docker build -t cbp-railway-splash .
docker run -p 8080:8080 -e SECRET="your-secret" cbp-railway-splash
```
