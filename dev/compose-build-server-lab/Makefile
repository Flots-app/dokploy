.PHONY: check destroy info manual-ready migration-target smoke smoke-clean start status stop

start:
	./scripts/up.sh

smoke: start
	./scripts/smoke.sh

smoke-clean:
	./scripts/clean-smoke.sh

manual-ready: start
	./scripts/clean-smoke.sh
	./scripts/info.sh
	@echo "Smoke routes removed. Add Dokploy Domains before enabling the Build Server."

migration-target:
	./scripts/migration-target-up.sh

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
