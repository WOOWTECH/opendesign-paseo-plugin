FROM ghcr.io/nexu-io/od:0.24.1@sha256:587a992857d0f8b71011e4bc55c5851e33ef9fc4c169fc17e6447700ac428f22
USER root
RUN apk add --no-cache python3 curl tini && mkdir -p /usr/local/share/npm
RUN node --input-type=module -e 'import fs from "node:fs";import crypto from "node:crypto";import {spawnSync} from "node:child_process";const m=await (await fetch("https://registry.npmjs.org/npm/10.9.4")).json();const u=new URL(m.dist.tarball);if(u.origin!=="https://registry.npmjs.org")throw Error("registry mismatch");const b=Buffer.from(await (await fetch(u)).arrayBuffer());if("sha512-"+crypto.createHash("sha512").update(b).digest("base64")!==m.dist.integrity)throw Error("integrity failure");fs.writeFileSync("/tmp/npm.tgz",b);if(spawnSync("tar",["-xzf","/tmp/npm.tgz","--strip-components=1","-C","/usr/local/share/npm"]).status)throw Error("extract failed");try{fs.unlinkSync("/usr/local/bin/npm")}catch(e){if(e.code!=="ENOENT")throw e}fs.symlinkSync("/usr/local/share/npm/bin/npm-cli.js","/usr/local/bin/npm");fs.unlinkSync("/tmp/npm.tgz")'
COPY --chown=1001:1001 . /opt/opendesign-agent-runtime
WORKDIR /opt/opendesign-agent-runtime
RUN npm ci --omit=dev --ignore-scripts --legacy-peer-deps && npm --version && python3 --version && ! command -v claude && ! command -v codex
COPY image/entrypoint.sh /usr/local/bin/od-agent-runtime-entry
RUN chmod 755 /usr/local/bin/od-agent-runtime-entry
USER 1001:1001
ENV HOME=/home/opendesign
ENV PATH="/home/opendesign/.local/bin:${PATH}"
RUN npm --version && python3 --version && curl --version && ! command -v claude && ! command -v codex
WORKDIR /app
ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/od-agent-runtime-entry"]
CMD ["node", "apps/daemon/bin/od.mjs", "--host", "127.0.0.1", "--port", "7457", "--no-open"]
