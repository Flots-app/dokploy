FROM docker:29.1.4-dind@sha256:d95427251fd155cd69a03311a8c4edf6d0778595444afc2d2c800a156eb2ecac
# --upgrade: the pinned base ships openssh-client packages that newer Alpine
# releases of openssh-server conflict with ("breaks: openssh-client-default").
RUN apk add --no-cache --upgrade bash coreutils curl git openssh-client-common openssh-server rsync \
    # Lock password login but keep the account usable for public keys.
    && sed -i 's/^root:[^:]*:/root:*:/' /etc/shadow \
    && sed -i 's@root:/bin/ash@root:/bin/bash@' /etc/passwd
COPY entrypoint.sh /usr/local/bin/preview-worker-entrypoint
RUN chmod 755 /usr/local/bin/preview-worker-entrypoint
ENTRYPOINT ["docker-init", "--", "/usr/local/bin/dind", "/usr/local/bin/preview-worker-entrypoint"]
