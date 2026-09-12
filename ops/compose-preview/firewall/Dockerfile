FROM alpine:3.23@sha256:fd791d74b68913cbb027c6546007b3f0d3bc45125f797758156952bc2d6daf40
RUN apk add --no-cache bash iptables jq
COPY firewall.sh /usr/local/bin/preview-firewall
RUN chmod 755 /usr/local/bin/preview-firewall
ENTRYPOINT ["/usr/local/bin/preview-firewall"]
