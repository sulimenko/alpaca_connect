FROM node:lts-slim
WORKDIR /usr/server
COPY . .
RUN npm i --production
CMD ["node", "server.js"]
EXPOSE 9000
# docker build -t connect:v2 .