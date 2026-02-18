FROM node:18-alpine

WORKDIR /app

COPY . .

RUN npm install --ignore-scripts

RUN npm run build

EXPOSE 3000

ENV PORT=3000

CMD ["node", "server.js"]