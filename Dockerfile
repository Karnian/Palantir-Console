FROM node:20-alpine

RUN apk add --no-cache curl bash ripgrep util-linux python3 make g++

RUN curl -fsSL https://opencode.ai/install | bash
ENV PATH="/root/.local/bin:/root/.opencode/bin:${PATH}"

WORKDIR /app
ENV NODEJS_ORG_MIRROR=http://nodejs.org/download/release

COPY package.json package-lock.json ./
RUN npm_config_strict_ssl=false NODE_TLS_REJECT_UNAUTHORIZED=0 npm ci --omit=dev
RUN npm install -g @openai/codex

COPY server ./server

ENV PORT=4177
EXPOSE 4177

CMD ["npm", "start"]
