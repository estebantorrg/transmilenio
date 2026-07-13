# Mirrors the image `fn deploy` builds for a Node runtime function, so the
# GitHub Actions pipeline can build + push it with plain Docker (no Fn CLI /
# oracle provider). Base images are the same ones the Fn Node FDK ships.
FROM fnproject/node:20-dev as build-stage
WORKDIR /function
ADD package.json /function/
RUN npm install --omit=dev

FROM fnproject/node:20
WORKDIR /function
COPY --from=build-stage /function/node_modules/ /function/node_modules/
ADD . /function/
ENTRYPOINT ["node", "func.js"]
