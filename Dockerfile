FROM node:24-alpine
WORKDIR /app
COPY server.mjs ./
COPY public ./public
ENV NODE_ENV=production
EXPOSE 9120
CMD ["node", "server.mjs"]
