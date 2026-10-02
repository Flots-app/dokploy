FROM docker:29.1.4-dind@sha256:d95427251fd155cd69a03311a8c4edf6d0778595444afc2d2c800a156eb2ecac
RUN apk add --no-cache bash coreutils curl git openssh-server rsync \
    && passwd -d root \
    && sed -i 's@root:/bin/ash@root:/bin/bash@' /etc/passwd
COPY entrypoint.sh /usr/local/bin/preview-worker-entrypoint
RUN chmod 755 /usr/local/bin/preview-worker-entrypoint
ENTRYPOINT ["docker-init", "--", "/usr/local/bin/dind", "/usr/local/bin/preview-worker-entrypoint"]
