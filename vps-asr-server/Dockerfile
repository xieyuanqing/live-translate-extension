FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg python3 python3-pip ca-certificates && pip3 install --break-system-packages yt-dlp && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY . .
EXPOSE 8787
CMD ["node", "server.js"]
