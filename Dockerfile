# Static build, served by nginx. No Node at runtime.
FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
# Baked in at build time — see README. Leave unset to talk to /api on the same
# origin, which is what the nginx config below expects.
ARG VITE_API_BASE_URL
ENV VITE_API_BASE_URL=$VITE_API_BASE_URL
RUN npm run build

FROM nginx:alpine
COPY --from=build /app/dist /usr/share/nginx/html
# nginx:alpine runs envsubst over /etc/nginx/templates/*.template at startup,
# so AGENT_URL is a RUNTIME setting here — unlike VITE_API_BASE_URL, one image
# can be pointed at different services per environment.
COPY nginx.conf /etc/nginx/templates/default.conf.template
ENV AGENT_URL=http://agent:3000
# Keeps nginx's own $variables from being eaten by envsubst.
ENV DOLLAR=$
EXPOSE 80
