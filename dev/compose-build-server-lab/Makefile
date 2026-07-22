.PHONY: check destroy info smoke smoke-clean start status stop

start:
	./scripts/up.sh

smoke: start
	./scripts/smoke.sh

smoke-clean:
	./scripts/clean-smoke.sh

status:
	./scripts/status.sh

info:
	./scripts/info.sh

stop:
	./scripts/stop.sh

destroy:
	./scripts/destroy.sh

check:
	./scripts/check.sh
