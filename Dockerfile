FROM scrapinghub/splash:3.5

USER root
# Install Node.js
RUN apt-get update && apt-get install -y curl && \
    curl -fsSL https://deb.nodesource.com/setup_16.x | bash - && \
    apt-get install -y nodejs && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# Set up the proxy app
WORKDIR /proxy
COPY package.json ./
RUN npm install
COPY server.js start.sh ./
RUN chmod +x start.sh

# Environment variables
ENV SPLASH_URL=http://localhost:8050
ENV PORT=8080

EXPOSE 8080

RUN chown -R splash /proxy
USER splash

CMD ["./start.sh"]
