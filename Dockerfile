# syntax = docker/dockerfile:1

# Adjust NODE_VERSION as desired
ARG NODE_VERSION=22.21.1
FROM node:${NODE_VERSION}-slim AS base

LABEL fly_launch_runtime="Next.js"

# Next.js app lives here
WORKDIR /app

# Set production environment
ENV NODE_ENV="production"


# Throw-away build stage to reduce size of final image
FROM base AS build

# Install packages needed to build node modules
RUN apt-get update -qq && \
    apt-get install --no-install-recommends -y build-essential node-gyp pkg-config python-is-python3

# Install node modules
COPY package.json ./
RUN npm install --include=dev

# Copy application code
COPY . .

# Build application
RUN npx next build --experimental-build-mode compile

# Remove development dependencies
RUN npm prune --omit=dev


# Final stage for app image
FROM base

# Copy built application
COPY --from=build /app /app

# Entrypoint sets up the container.
#
# .cjs, not .js: package.json has "type": "module" (added in Stage 2 to
# silence a Vite config warning), which makes Node treat every .js file as
# an ES module - and this Fly-generated entrypoint is CommonJS
# (`require`). That mismatch crash-looped the container on every boot
# ("ReferenceError: require is not defined in ES module scope"), so the
# server never bound port 3000 and Fly had nothing to serve. Renaming to
# .cjs opts this one file back into CommonJS without touching the rest of
# the project's ESM setup.
ENTRYPOINT [ "/app/docker-entrypoint.cjs" ]

# Start the server by default, this can be overwritten at runtime
EXPOSE 3000
CMD [ "npm", "run", "start" ]
