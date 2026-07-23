FROM nginx:1.29-alpine
ARG DOKPLOY_DEPLOYMENT_ID
ARG SLOW_BUILD_SECONDS=0
RUN sleep "${SLOW_BUILD_SECONDS}" \
	&& printf 'back-office:%s\n' "${DOKPLOY_DEPLOYMENT_ID}" >/usr/share/nginx/html/index.html
EXPOSE 80
