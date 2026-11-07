# T-538 attempt image (plan section 6). Stub model and fake credential only until the owner's word.
# Everything under /opt is read-only at run time because the root file system is. The envelope,
# helper, pack script and reviewer shim join /opt/eval in the commits that own them.
FROM node@sha256:752ea8a2f758c34002a0461bd9f1cee4f9a3c36d48494586f60ffce1fc708e0e
LABEL cpm-t538-image=attempt
RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends bash coreutils git lsof procps python3 util-linux ca-certificates >/dev/null
RUN npm i -g --silent --prefix /opt/codex @openai/codex@0.163.0
COPY pkg /opt/storybloq
RUN cd /opt/storybloq && npm ci --omit=dev --ignore-scripts --silent
# The project folder exists in the image, owned by eval, so --workdir does not create it as root.
RUN useradd -m -u 1001 -U eval && mkdir -p /vol/att/project && chown -R eval:eval /vol/att
COPY relay.mjs sup.mjs /opt/eval/
COPY storybloq-launcher /opt/eval/bin/storybloq
RUN chmod -R a+rX /opt/eval && chmod 555 /opt/eval/bin/storybloq
USER eval
