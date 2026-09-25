FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm install --omit=dev
COPY server.js questions.json ./
COPY public ./public
EXPOSE 3000
CMD ["node", "server.js"]
