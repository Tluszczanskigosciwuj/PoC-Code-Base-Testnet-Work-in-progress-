FROM node:20-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./

RUN npm install --omit=dev

COPY src/ ./src/
COPY chocohub.js ./
COPY cli.js ./

RUN mkdir -p /app/db /app/node-data /app/plots

EXPOSE 3800

ENV NODE_ENV=production

CMD ["node", "src/index.js"]
