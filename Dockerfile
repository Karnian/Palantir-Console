FROM node:20-alpine

RUN apk add --no-cache curl bash ripgrep

RUN curl -fsSL https://opencode.ai/install | bash
ENV PATH="/root/.local/bin:/root/.opencode/bin:${PATH}"

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server ./server

ENV PORT=4177
EXPOSE 4177

CMD ["npm", "start"]
