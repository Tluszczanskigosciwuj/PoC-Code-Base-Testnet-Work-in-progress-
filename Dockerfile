FROM node:20-slim

RUN apt-get update && \
    apt-get install -y python3 make g++ && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm install --production

COPY src/ ./src/
COPY chocohub.js ./
COPY cli.js ./

EXPOSE 3001

CMD ["node", "src/index.js"]
