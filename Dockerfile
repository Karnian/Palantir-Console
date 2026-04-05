FROM node:20-alpine

RUN apk add --no-cache curl bash git tmux python3 make g++

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server ./server
COPY CLAUDE.md AGENT.md ./

ENV PORT=4177
EXPOSE 4177

CMD ["npm", "start"]
