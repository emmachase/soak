FROM node:20-slim AS base
COPY . /app
WORKDIR /app

FROM base AS prod-deps
RUN npm ci --omit=dev

FROM base AS build
RUN npm ci
RUN npm run build

FROM base
COPY --from=prod-deps /app/node_modules /app/node_modules
COPY --from=build /app/build /app/build

ENV NODE_ENV=production
CMD [ "node", "/app/build/index.js" ]
