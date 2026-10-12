FROM ghcr.io/nexu-io/od:0.24.1@sha256:587a992857d0f8b71011e4bc55c5851e33ef9fc4c169fc17e6447700ac428f22
USER root
RUN apk add --no-cache bash curl gcompat libgcc libstdc++ python3 ripgrep tini && mkdir -p /usr/local/share/npm
RUN node --input-type=module -e 'import fs from "node:fs";import crypto from "node:crypto";import {spawnSync} from "node:child_process";const m=await (await fetch("https://registry.npmjs.org/npm/10.9.4")).json();const u=new URL(m.dist.tarball);if(u.origin!=="https://registry.npmjs.org")throw Error("registry mismatch");const b=Buffer.from(await (await fetch(u)).arrayBuffer());if("sha512-"+crypto.createHash("sha512").update(b).digest("base64")!==m.dist.integrity)throw Error("integrity failure");fs.writeFileSync("/tmp/npm.tgz",b);if(spawnSync("tar",["-xzf","/tmp/npm.tgz","--strip-components=1","-C","/usr/local/share/npm"]).status)throw Error("extract failed");try{fs.unlinkSync("/usr/local/bin/npm")}catch(e){if(e.code!=="ENOENT")throw e}fs.symlinkSync("/usr/local/share/npm/bin/npm-cli.js","/usr/local/bin/npm");fs.unlinkSync("/tmp/npm.tgz")'
RUN npm install --global @anthropic-ai/claude-code@2.1.296 @openai/codex@0.162.1 && npm install --global --ignore-scripts @earendil-works/pi-coding-agent@1.1.0 && npm cache clean --force && rm -rf /root/.npm
USER 1001:1001
ENV HOME=/home/opendesign
ENV PATH="/home/opendesign/.local/bin:${PATH}"
RUN node --version && npm --version && claude --version && codex --version && pi --version
WORKDIR /app
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "apps/daemon/bin/od.mjs", "--host", "127.0.0.1", "--port", "7457", "--no-open"]
