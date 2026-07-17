FROM node:24-bookworm-slim

ENV NODE_ENV=production \
    CAP_NO_OPEN=1

WORKDIR /app

# CAP's approved, functional web interface is already committed in dist.
# Do not rebuild from src/App.tsx here because that source is only a placeholder.
COPY dist ./dist
COPY launch-cap.cjs ./launch-cap.cjs

RUN mkdir -p /app/data/uploads

EXPOSE 1420

CMD ["node", "launch-cap.cjs"]