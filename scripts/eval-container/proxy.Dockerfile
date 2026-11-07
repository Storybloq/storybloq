# T-538 proxy image (plan section 5, amendment A1). Carries no /vol folder, so no volume is copied up.
FROM node@sha256:752ea8a2f758c34002a0461bd9f1cee4f9a3c36d48494586f60ffce1fc708e0e
LABEL cpm-t538-image=proxy
COPY proxy.mjs /opt/proxy.mjs
RUN chmod 444 /opt/proxy.mjs
