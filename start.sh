#!/bin/bash

# Start Splash in the background
echo "Starting Splash server on port 8050..."
python3 /app/bin/splash --port 8050 &

# Wait briefly for Splash to initialize
sleep 3

# Start the Node.js proxy server in the foreground
echo "Starting Node.js Proxy Server..."
node server.js
