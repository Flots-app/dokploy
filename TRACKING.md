# Application Build Servers and zero-downtime Dockerfile deployments

## Current objective

- [x] Make every Dokploy Application use an organization-owned, active VM whose
  `serverType` is strictly `build`; a deploy server must never be accepted as an
  Application Build Server.
- [x] Automatically make the only Build Server in an organization the default;
  when several exist, keep exactly one explicitly selectable default.
- [x] Refuse Application builds when no valid Build Server is available.
- [x] Give Git-backed `buildType: dockerfile` Applications the same safety
  properties as Compose Build Server deployments: checkout/build/push and logs
  on the Build Server, immutable deployment images, pull-before-mutation on the
  runtime server, start-first health-gated activation, rollback on activation
  failure, and no application container on the Build Server.
- [x] Route every manual, redeploy, refresh-token and GitHub push/tag trigger,
  queue partition, cancellation, patch and commit-log operation through the
  effective Build Server.
- [x] Update the Application and Server interfaces so the invariant and default
  are visible and configurable without allowing `None` as an Application Build
  Server.
- [x] Add schema/migration, authorization, orchestration, command-generation and
  UI tests; run the repository quality, typecheck and focused/complete tests.
- [x] Publish a draft pull request against `canary` with requirement-by-
  requirement evidence: [Flots-app/dokploy#22](https://github.com/Flots-app/dokploy/pull/22).
- [x] Publish and deploy `v0.29.14-flots.6` from the merged `canary`, then
  verify the production migration and service health.
- [ ] Publish the cross-platform Application Build Server follow-up and verify
  an arm64 Build Server can activate an amd64 production release.

## Current findings

- The existing Application integration is partial: it can execute a build on
  `application.buildServerId`, but it tags/pushes `latest`, accepts the fields
  through the generic update mutation, does not validate server type or
  organization, and several triggers/queue/cancellation paths still target the
  deploy server.
- Application runtime activation already uses Docker Swarm and defaults to
  `start-first`, but deployment completion is recorded immediately after the
  update API call. It does not pull and verify the immutable image before
  mutation or wait for Swarm convergence/health, so it does not yet prove
  zero-downtime behavior.
- The pre-existing local migration journal was preserved at
  `/private/tmp/dokploy-TRACKING.user-20260814.md` before switching to the latest
  `canary`, which now tracks this file.

## Current progress

- [x] Fetch current `origin/canary` and create
  `codex/application-build-server-zero-downtime` without touching
  `.env.production`.
- [x] Audit Application schema/API/UI, build/push commands, deployment logging,
  queues/webhooks, Server lifecycle/default support and Compose blue/green
  primitives.
- [x] Finalize the implementation contract and compatibility/migration rules:
  nullable set-null foreign keys for compatibility, one active SSH-capable
  organization default, strict runtime resolution, and a Git/Dockerfile V1 for
  health-gated immutable activation.
- [x] Add the schema, deterministic backfill/repair migration, dedicated
  mutations, organization/permission/type validation, automatic default
  assignment, and lifecycle guards.
- [x] Route main and preview checkout/build/push, patches, commit metadata,
  deployment logs, queues, webhooks, refresh-token triggers and cancellation
  through the effective Build Server.
- [x] Implement immutable deployment-ID images, reserved environment/build
  arguments, registry logins through stdin, platform validation, pull before
  mutation, start-first Swarm activation, convergence/stabilization checks and
  explicit rollback/removal after a failed or cancelled activation.
- [x] Replace the optional Application UI with required Build Server/registry
  selection and expose the organization default on the Server cards.
- [x] Finish focused tests and complete repository validation.
- [x] Pass both TypeScript projects, Biome across 918 files, 59 focused tests,
  and the complete non-real suite (85 files, 797 tests). The local real test
  file requires the external `nixpacks` binary; its Dockerfile prerequisite
  case passes and CI remains responsible for the provisioned real environment.
- [x] Resolve the 11 React Doctor warnings reported on PR #22; React Doctor
  0.9.12 reports no changed-scope issues against `origin/canary`, and the full
  797-test suite still passes after the concurrency refactor.
- [x] Merge [Flots-app/dokploy#22](https://github.com/Flots-app/dokploy/pull/22)
  into `canary` at `785261e9c48f2960b6070f02a9386f0693ba8f9f`.
- [x] Publish the attested amd64/arm64 `v0.29.14-flots.6` image and promote its
  verified digest to `latest`.
- [x] Deploy `v0.29.14-flots.6` to production and verify migrations, Dokploy,
  PostgreSQL, Redis, Traefik, and the existing runtime services.
- [x] Restore `flots.app` and `www.flots.app` to HTTP 200 with the last local
  amd64 image after the legacy Application Build Server path left its Swarm
  service without a runnable image; keep that recovery release active while
  the cross-platform fix is built and published.
- [x] Replace the Application architecture equality rejection with an explicit
  Docker `--platform` target derived from the Deploy Server, preserving legacy
  builds without a target and documenting the cross-platform builder
  requirement.
- [x] Merge the cross-platform fix in
  [Flots-app/dokploy#24](https://github.com/Flots-app/dokploy/pull/24) at
  `d0f8a7587170bd3b913821c844b51240a0a55d02` after every required check passed.
- [x] Publish and deploy `v0.29.14-flots.7`, then prove the arm64 Mac mini
  builds and pushes linux/amd64 website images while continuous HTTP probes
  remain successful through protected candidate rollbacks.
- [x] Replace the production website health check with the available BusyBox
  `wget`, reproduce the anchored Swarm name filter returning no replicas, and
  merge the exact service-ID convergence fix in
  [Flots-app/dokploy#26](https://github.com/Flots-app/dokploy/pull/26) at
  `ff94bf1f5aef5e2d7ebaa545a88a521ccdc2cb77`.
- [x] Publish and deploy `v0.29.14-flots.8`; prove its immutable amd64 website
  candidate reaches `Running`, then preserve HTTP 200 traffic while the
  aggregate-replica stabilization check safely rolls it back during drain.
- [x] Replace aggregate Swarm replica checks with image-specific
  `desired-state=running` task checks for activation and rollback, and merge
  [Flots-app/dokploy#28](https://github.com/Flots-app/dokploy/pull/28) at
  `bdab8b3c92759220a7408186f246ce89a8b553f3`.
- [ ] Publish `v0.29.14-flots.9`, activate the current website release, and
  prove the immutable amd64 task remains stable with no failed HTTP probes.
- [x] Commit, push and open the draft PR.

---

# S3 backup encryption at rest

## TODO

- [ ] Run the external-infrastructure smoke test recorded under **TO VERIFY**
  when a disposable remote Dokploy server and production S3 credentials are
  available.

## IN PROGRESS

- None — the backup-size and restore-source UX release is deployed and verified.

## TO VERIFY

- [ ] Run one backup/restore smoke test on a real remote Dokploy server and a
  production S3 provider during review; this needs external infrastructure and
  credentials that are not available in this workspace.
- [ ] Exercise the browser's WebSocket restore-subscription transport on a
  production-like deployment. The local campaign inspected that UI flow but
  invoked the exact backend restore function directly for deterministic
  verification.
- [ ] Repeat the Docker lab under the repository's required Node 24.4 runtime.
  The local server used Node 22.15; the branch's complete GitHub CI already
  passes under Node 24/Linux.

## DONE

- [x] Published stable release
  [v0.29.14-flots.5](https://github.com/Flots-app/dokploy/releases/tag/v0.29.14-flots.5)
  from `canary`; the release workflow built, pushed, attested, and verified
  Linux amd64/arm64 images before promoting the multi-architecture manifest.
- [x] Deployed `v0.29.14-flots.5` to `https://dokploy.flots.app` after the
  PostgreSQL, Redis, and Traefik preflight passed; the dashboard recovered with
  10 running, 0 errored, and 2 idle services.
- [x] Verified the production encrypted R2 listing: the Dokploy backup file and
  its generated root directory both display a logical cumulative size of
  `1.25 GB` instead of `0 Bytes`.
- [x] Verified the production restore UX identifies `/dokploy`, `/intraday`,
  `/daily`, and `/monthly` by storage prefix and destination, shows each
  schedule/retention, and opens the exact configured path without restoring or
  changing any backup.
- [x] Published and merged
  [Flots-app/dokploy#18](https://github.com/Flots-app/dokploy/pull/18) into
  `canary`; Plumber compliance, quality, typecheck, complete tests, production
  build, and React Doctor all passed under Node 24/Linux.
- [x] Made backup listings recurse once through rclone and aggregate descendant
  object bytes into each immediate directory, while keeping direct files and
  the existing 100-entry/search behavior.
- [x] Added a restore-source selector that identifies configured backups by
  storage prefix, destination, schedule, and retention; selecting one opens its
  exact path while manual destination browsing remains available.
- [x] Added seven focused tests for nested sizes, prefix collisions, empty and
  invalid sizes, immutability, and normalized storage paths; all 40 backup tests,
  Dokploy/server typechecks, Biome across 912 files, the server bundle, and the
  production Next.js build pass locally.
- [x] Built a disposable Docker Compose lab with Dokploy PostgreSQL/Redis,
  MinIO, and a Docker-labeled PostgreSQL 17 source service; ran the real Dokploy
  development server and database migrations against it.
- [x] Downloaded the official macOS rclone v1.75.0 archive and verified its
  published SHA-256 (`35e8f2a666ce789b29111db0dd843ddabc0d59c6b609d07bcaae5d1a07cba6f8`)
  before placing the binary on the lab server's `PATH`.
- [x] Created Dokploy-managed and customer-managed destinations through the
  running UI, passed both connection tests, verified password-type customer-key
  inputs and ownership badges, and exercised creation/list/update APIs.
- [x] Verified API redaction and database persistence: both crypt passwords are
  always `null` in destination responses, both are distinct AES-GCM `enc:v1:`
  values at rest, and supplied customer plaintext fragments do not appear in
  the database.
- [x] Ran a real PostgreSQL backup through Dokploy's Docker discovery,
  `pg_dump`, gzip, rclone crypt, and MinIO path for a fixture containing ASCII,
  Unicode, emoji, quotes, shell metacharacters, multiline text, NULL/empty
  values, binary bytes, a zero byte, large fields, and an empty table.
- [x] Restored managed- and customer-key backups through Dokploy's real backend
  restore function after deliberately replacing the source data. Both restored
  four rows with canonical logical digest
  `737bb4a9c596d51203b0965d8c00e89f`, including the empty table, while an
  unrelated sentinel table remained intact.
- [x] Inspected raw MinIO storage: managed and customer destinations use
  separate `.dokploy/encrypted/v1/<destinationId>` roots; logical directories
  and filenames are absent, encrypted objects have rclone's ciphertext header,
  and the managed object's physical SHA-256 is
  `c41592810253b3bf4f0968e7d052e605806a7b12c10cd42b5d80c14f0ad74edd`.
- [x] Ran three real customer-key backups with `keepLatestCount=2`; retention
  kept exactly the newest two readable encrypted objects. With a wrong key it
  found no logical files, deleted nothing, and left both raw objects intact.
- [x] Verified encrypted-destination isolation, including different key sets in
  one bucket, and verified legacy plaintext coexistence outside the encrypted
  namespace with a valid gzip object and unchanged legacy behavior.
- [x] Verified safe mutations: display-name edits and a real S3 credential
  rotation to a second MinIO user preserved access to the encrypted object;
  changing an encrypted destination's bucket failed with the explicit immutable
  storage-identity error. Original credentials were restored afterward.
- [x] Exercised API validation failures for managed mode with client secrets,
  customer mode without a primary key, disabled encryption with a key, equal
  primary/secondary keys, line breaks, case-insensitive `--crypt-*` overrides,
  and incompatible filename/directory modes; all failed with the expected
  field-level HTTP 400 response.
- [x] Exercised wrong customer keys, a missing encrypted object, deliberately
  corrupted ciphertext, and a purged-then-restored physical object. Restore
  failures were non-zero, S3 credentials and crypt secrets were absent from
  errors/logs, and the source database retained its canonical digest.
- [x] Restarted Dokploy with the correct master encryption key, with a wrong
  `ENCRYPTION_KEY`, then with the correct key again. The wrong-key instance
  redacted destination secrets, failed encrypted listing without data damage,
  and the final restart recovered access to the original logical object.
- [x] Corrected the encrypted-column diagnostic discovered by the restart test
  so it identifies either `ENCRYPTION_KEY` or `BETTER_AUTH_SECRET` as a possible
  mismatch instead of naming only the legacy auth-secret source.
- [x] Passed the post-E2E regression gates: 59 focused tests across five files,
  Dokploy and server TypeScript checks, and Biome on the corrected source file.
- [x] Removed the temporary restore/retention helpers and dismantled the
  disposable lab, including its four containers, isolated network, temporary
  MinIO user, and three data volumes.
- [x] Confirmed the local repository and PR target context.
- [x] Retrieved PR metadata, changed-file list, discussion, reviews, and review threads.
- [x] Audited `Dokploy/dokploy#3194` against upstream `canary`, this fork, and
  the official rclone crypt documentation.
- [x] Reproduced the source PR's raw-password failure with rclone: crypt
  passwords supplied through config environment variables must first be
  obscured.
- [x] Rejected the source PR's mutable encryption settings because disabling or
  rotating crypt credentials makes existing objects unreadable.
- [x] Identified source-PR regressions in retention (`xargs` plus environment
  assignment), volume remote paths, encryption-aware connection tests, LibSQL,
  Compose runtime selection, `additionalFlags`, and credential redaction.
- [x] Designed a versioned encrypted namespace at
  `.dokploy/encrypted/v1`, leaving legacy plaintext destinations unchanged.
- [x] Added schema constraints, generated migration `0176_petite_vector`, API
  validation/redaction, and immutable encryption configuration after creation.
- [x] Added the destination UI with secure browser-generated passwords,
  filename/directory encryption controls, and explicit recovery guidance.
- [x] Routed PostgreSQL, MySQL, MariaDB, MongoDB, LibSQL, Compose, web-server,
  and volume backup/list/restore/retention operations through one crypt-aware
  command builder.
- [x] Kept obscured crypt secrets out of command arguments and error command
  strings: native child-process environments locally and stdin-fed exports over
  SSH, with defensive error redaction.
- [x] Added traversal/control-character rejection and shell-safe path handling;
  repaired nested local filenames for web-server and volume restores.
- [x] Passed 39 focused encryption, redaction, remote-environment, and command
  injection tests.
- [x] Passed the complete non-real suite: 77 files and 732 tests.
- [x] Passed server and Dokploy typechecks, Biome format/lint, migration
  consistency, server bundle, and production Next.js build.
- [x] Validated actual rclone v1.74.4 behavior against MinIO: upload, logical
  listing, restore, encrypted physical filenames/content, and no crypt secret in
  generated command strings.
- [x] Published draft pull request
  [Flots-app/dokploy#13](https://github.com/Flots-app/dokploy/pull/13) against
  `canary`.
- [x] Expanded focused coverage to 43 passing tests for crypt modes,
  per-destination namespaces, inherited environment isolation, path and local
  filename boundaries, retention command safety, schema rules, service
  redaction, storage immutability, and SSH stdin environment transfer.
- [x] Fixed update-response disclosure of the reversible obscured crypt
  passwords.
- [x] Isolated encrypted object roots by immutable `destinationId` so two
  destinations sharing one bucket but using different keys cannot mix data.
- [x] Froze encrypted storage identity (provider, bucket, region, endpoint, and
  additional flags) while preserving display-name edits and S3 credential
  rotation.
- [x] Explicitly pinned every security-relevant crypt environment option,
  cleared an inherited optional `password2`, enabled strict name handling, and
  rejected additional `--crypt-*` overrides.
- [x] Reproduced that rclone `copyto` exits successfully when its source is
  absent; added `--error-on-no-transfer` to every upload/download `copyto` and
  verified the resulting exit code 9 against MinIO.
- [x] Made retention fail closed: positive safe-integer validation, Bash
  `pipefail`, a required non-empty listing, an authenticated one-byte read, and
  stdin file deletion restricted to Dokploy backup extensions.
- [x] Added database checks for disabled-destination secret absence and the
  filename/directory mode invariant; migration generation reports no schema
  drift.
- [x] Passed the real rclone/MinIO edge matrix for all three filename modes,
  directory modes, special-character passwords, password2 present/absent,
  binary and zero-byte payloads, wrong keys, deliberate ciphertext corruption,
  destination isolation, and plaintext legacy coexistence.
- [x] Passed real encrypted retention for database and volume patterns,
  keep-latest ordering, unrelated-file preservation, and wrong-key failures
  with both encrypted and plaintext filenames.
- [x] Passed Biome over all 907 files, all workspace typechecks, server build,
  production server bundle, full Next.js production build, and migration
  consistency. The current non-real suite passes 748/749 tests; the sole local
  failure is an unrelated Compose cancellation test timing out at 5 seconds on
  Node 22 and is delegated to the Node 24/Linux CI run.
- [x] Published hardening commit `207811d9a` and passed every required check on
  draft PR #13 under Node 24/Linux: Plumber compliance, quality, typecheck,
  complete test suite, and production build.
- [x] Cross-checked the requested key-ownership model against Azure's
  platform-managed and customer-managed key responsibilities, then adapted the
  concept to rclone's client-side crypt model without claiming external-vault
  or online key-revocation semantics.
- [x] Added an immutable `encryptionKeyManagement` contract with
  `dokploy`/`customer` modes. New destinations default to Dokploy-managed keys;
  customer-managed mode requires user-provided recovery secrets.
- [x] Moved managed-key generation entirely to the server using two independent
  256-bit CSPRNG values. Managed mode rejects client-supplied key material, and
  disabled encryption rejects unused secrets.
- [x] Wrapped both rclone-obscured passwords in Dokploy's AES-256-GCM
  `encryptedText` storage while preserving API redaction and legacy plaintext
  read compatibility.
- [x] Added database constraints for valid key-management modes and the required
  secondary secret on Dokploy-managed encrypted destinations; migration
  generation reports no schema drift.
- [x] Added an accessible key-management selector, explicit recovery ownership
  guidance, immutable-mode messaging, and visible destination-list badges.
- [x] Expanded focused coverage to 48 passing tests, including API ownership
  rules, server-side key entropy/independence, encrypted-at-rest persistence,
  secret redaction, command safety, and both disabled/enabled boundaries.
- [x] Passed a real rclone v1.75.0/MinIO integration for Dokploy-managed and
  customer-managed namespaces: exact upload/restore hashes, distinct encrypted
  physical names/content, isolation between key sets, and exit-code 9 failures
  for a wrong primary key or missing managed secondary key.
- [x] Passed Biome across all 907 files, all four workspace typechecks, the
  server production bundle, the full Next.js production build, and migration
  consistency. The non-real local suite passes 753/754 tests under Node 26;
  only the unrelated pre-existing Compose cancellation test exceeds its local
  5-second timeout and remains delegated to the Node 24/Linux CI gate.
- [x] Rebased the complete encryption branch onto current `canary`, published
  managed-key commit `ccacd0a34`, and updated draft PR #13 with the ownership,
  recovery, threat-boundary, cross-source, and validation details.
- [x] Passed every required GitHub check after publication under Node 24/Linux:
  Plumber compliance, quality, typecheck, complete test suite, and production
  build.
- [x] Rebased the seven encryption commits without conflicts onto `canary`
  commit `dd2cee10b`, which introduced the React Doctor PR gate.
- [x] Reproduced React Doctor 0.9.11 locally, replaced its two reported barrel
  imports with direct module imports, and reached a clean 41-file changed-scope
  scan with zero findings.
- [x] Revalidated the post-rebase fix with Biome across 907 files, 48 focused
  tests, the server production build, and all four workspace typechecks.
- [x] Published React Doctor cleanup commit `fdad52d6c` and passed every gate on
  the rebased PR: React Doctor (85/100, zero findings), Plumber compliance,
  quality, typecheck, complete test suite, and production build.
