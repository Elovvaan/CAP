# syntax=docker/dockerfile:1.7

FROM node:24-bookworm-slim AS build

WORKDIR /app

ENV npm_config_audit=false \
    npm_config_fund=false \
    npm_config_update_notifier=false

# Railway only needs the browser application. Install the exact web/build
# packages directly so the Linux image does not download the Tauri desktop CLI.
RUN npm install --no-save --ignore-scripts --no-audit --no-fund \
      react@18.3.1 \
      react-dom@18.3.1 \
      lucide-react@0.468.0 \
      typescript@5.7.2 \
      vite@6.0.3 \
      @vitejs/plugin-react@4.3.4 \
      @types/react@18.3.12 \
      @types/react-dom@18.3.1

COPY . .
RUN ./node_modules/.bin/tsc && ./node_modules/.bin/vite build

FROM node:24-bookworm-slim AS runtime

ENV NODE_ENV=production \
    CAP_NO_OPEN=1

WORKDIR /app

COPY --from=build /app/dist ./dist
COPY --from=build /app/launch-cap.cjs ./launch-cap.cjs

RUN mkdir -p /app/data/uploads

EXPOSE 1420

CMD ["node", "launch-cap.cjs"]
