FROM node:22-alpine

RUN apk add --no-cache ffmpeg

WORKDIR /app
COPY server.js index.html ./

# O config.json (com a senha da câmera) NÃO entra na imagem: é montado em /app/config.json.
ENV FFMPEG_PATH=ffmpeg
EXPOSE 8090
USER node
CMD ["node", "server.js"]
