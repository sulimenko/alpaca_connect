FROM node:22.18.0-alpine
WORKDIR /usr/server
COPY package*.json .
RUN apk add --no-cache git
RUN npm ci --only=production
COPY . .
RUN npm i --production
EXPOSE 9000
CMD ["node", "server.js"]
# docker build -t connect:v2 .