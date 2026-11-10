FROM node:22-alpine

RUN apk add --no-cache ffmpeg

WORKDIR /app
COPY server.js camera-registry.js live.js index.html ./

# O config.json (chaves do WhatsApp) e o cameras/ (senhas das câmeras) NÃO entram na imagem: são montados em /app/config.json e /cameras.
ENV FFMPEG_PATH=ffmpeg
EXPOSE 8090
USER node
CMD ["node", "server.js"]
