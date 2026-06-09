FROM node:20-bullseye-slim

RUN apt-get update && apt-get install -y python3 make g++ poppler-utils && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .

EXPOSE 3000
CMD ["node", "server.js"]
