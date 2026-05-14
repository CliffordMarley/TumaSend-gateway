# ─── Stage 1: install production dependencies ────────────────────────────────
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# ci = reproducible install; omit=dev drops devDependencies (e.g. nodemon)
RUN npm ci --omit=dev

# ─── Stage 2: minimal runtime image ──────────────────────────────────────────
FROM node:22-alpine AS runtime
WORKDIR /app

# Run as non-root
RUN addgroup -S app && adduser -S app -G app

# Copy only what the process needs
COPY --from=deps --chown=app:app /app/node_modules ./node_modules
COPY --chown=app:app src/ ./src/
COPY --chown=app:app package.json ./

USER app

# Hardcode infrastructure-level config that never changes between deployments
ENV NODE_ENV=production \
    PORT=3000 \
    KANNEL_HOST=kannel \
    KANNEL_PORT=13013 \
    KANNEL_SENDSMS_URL=http://kannel:13013/cgi-bin/sendsms

EXPOSE 3000

CMD ["node", "--require", "./src/tracing.js", "src/app.js"]
