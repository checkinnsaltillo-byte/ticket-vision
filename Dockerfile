FROM node:20-slim

WORKDIR /app

COPY files/package*.json ./
RUN npm install --omit=dev

COPY files/ .

ENV PORT=8080

CMD ["npm", "start"]
