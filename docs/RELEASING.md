# Releasing

This is the maintainers' procedure. It is public so that anyone can see how a release is made and what it does and does not promise. The release works like the ship agent's ([github.com/turbokast/botwarren-ship](https://github.com/turbokast/botwarren-ship)): the same gated workflow shape, but a **different Cloud KMS key and a different service account**: the Companion never uses the key that signs the ship agent's updates (see "Two keys" below).

## What a release contains

For a version `X.Y.Z` the release workflow ([`.github/workflows/release.yml`](../.github/workflows/release.yml)) produces, from a `v*` tag on `main`:

| File | What it is |
|---|---|
| `client-X.Y.Z.tar.gz` | the web client: `index.html`, the loader, the app and its stylesheet, and `manifest.json` + `manifest.json.sig` |
| `client-manifest.json`, `client-manifest.json.sig` | the same manifest and its Ed25519 signature (domain `botwarren-client-v1`), unpacked so a reviewer can read them. The manifest lists the SHA-256 of every client file |
| `companion-X.Y.Z.zip` | the installable component: `companion.mjs` (one bundled file), `VERSION`, `LICENSE`, `NOTICE`. The ship agent installs exactly this, after the user consents |
| `component-manifest.json`, `component-manifest.json.sig` | the component manifest (Ed25519, domain `botwarren-component-v1`) the ship agent verifies against its pinned keys before it extracts anything. Its counter only goes up (anti-rollback) |
| `relay-context-X.Y.Z.tar.gz` | the **relay image inputs**: a build context for `deploy/Dockerfile.relay` containing the relay and protocol sources, the lockfile and `client/` (the signed web client). See [RELAY.md](RELAY.md) |
| `SHA256SUMS` | the hash of every file above |
| `attestations-X.Y.Z.sigstore.jsonl` | the GitHub build-provenance attestation of all of them (GitHub Release only) |

They are published to the GitHub Release and to Cloudflare R2 (`https://downloads.botwarren.com/companion/`). Layout: `companion/<version>/` holds every file of that release, immutable. The flat paths the ship agent reads are `companion/companion-<version>.zip` (immutable), `companion/manifest.json.sig` and `companion/manifest.json` (the signed component manifest, **uploaded last**: it is what makes the release visible to the agent), and `companion/latest.txt`.

There is **no unsigned mode**. The client and the component are only useful signed, so a release with `RELEASE_SIGNING` unset fails closed.

## Cutting a release

1. In a pull request: bump `version` in `package.json`, `apps/companion/package.json` and `apps/relay/package.json` and `VERSION` in `apps/companion/src/commands.ts` (the workflow refuses a tag that does not match all four), update `version` and `date-released` in `CITATION.cff`, and move the entries from `## [Unreleased]` in [`CHANGELOG.md`](../CHANGELOG.md) under a new dated `## [X.Y.Z] - YYYY-MM-DD` heading. Merge to `main`. The workflow fails closed if that section is missing, undated or empty, and uses it as the body of the GitHub Release (`apps/companion/scripts/changelog-notes.mjs`).
2. Tag the merge commit and push the tag: `git tag -s vX.Y.Z -m "vX.Y.Z" && git push origin vX.Y.Z`. The workflow refuses a tag that is not on `main`.
3. **build** (no secrets, read-only token): typecheck, tests, then the client and the component with `SOURCE_DATE_EPOCH` set to the commit time. **reproduce**: a second, independent build; its `SHA256SUMS` must be identical.
4. **sign** waits for approval of the **`release`** environment. Review the build job's summary (the list of hashes) and the diff of `.github/`, `apps/companion/scripts/`, `apps/companion/client/`, `apps/companion/vendor/` and `apps/relay/` since the previous tag, then approve. The job downloads the build output and the release notes, checks the hashes, fetches the previous component manifest from the downloads host (verified against the pinned keys before use) to set the next manifest counter, finalises the component manifest (`assemble-component-manifest.mjs`: it rebuilds nothing), authenticates to Google Cloud with GitHub OIDC (no key file), signs the client manifest and the component manifest with Cloud KMS, packages the release (`stage-release.mjs`) and verifies it against the **pinned** public key (`verify-release.mjs`). If anything fails, nothing is published.
5. **relay-image** builds the relay image from the signed relay image inputs and smoke-tests it (starts, serves `/healthz`, serves exactly the signed client manifest).
6. **publish** waits for the **`release`** environment again (a second approval, because it is a separate job). It re-checks the downloaded files against `SHA256SUMS`, attests them, uploads to R2 (immutable versioned files, the flat zip, the signature, then `manifest.json`, then `latest.txt`) and creates the GitHub Release (marked pre-release while the version is `0.x`).
7. Check the result: `gh attestation verify` on one file, `node apps/companion/scripts/verify-release.mjs <downloaded files>`, fetch `https://downloads.botwarren.com/companion/latest.txt` and `.../companion/manifest.json`. In the Google Cloud console (Logging, `cloudkms.googleapis.com` AsymmetricSign) there must be exactly **two** signing entries for this run (the client manifest and the component manifest), from `companion-signer@botwarren-release.iam.gserviceaccount.com` (never `release-signer`), and the alert e-mail(s).
8. Deploy the relay from this release (the operator's step): [RELAY.md](RELAY.md).

The component manifest is valid for 90 days (the ship agent installs nothing from an expired one, and never stops a running companion). Publish a release, or sign a fresh manifest with the emergency procedure below, within 90 days. The client manifest is valid for 400 days.

## One-time setup (repository owners)

The order matters: nothing in the release workflow works until the Google side accepts this repository. Do these steps in order.

### 1. The repository

Create `turbokast/botwarren-companion` (public, empty), push the exported tree to `main`, and apply the settings in [REPO_SETTINGS.md](REPO_SETTINGS.md): the `release` environment, the rulesets, Actions permissions, security features. Do not set `RELEASE_SIGNING` yet.

### 2. Google Cloud: a key and a service account of their own, reachable only from this repository

**Two keys, on purpose.** The ship agent's updates are signed with `kms-2026a` (Cloud KMS key `manifest-signing`, service account `release-signer`). The Companion's client and component are signed with a **different** key: `kms-comp-2026a` (Cloud KMS key `component-signing`, Ed25519, key ring `botwarren-release`, `europe-west2`), usable only by a **different** service account, `companion-signer@botwarren-release.iam.gserviceaccount.com`, which holds `roles/cloudkms.signerVerifier` on that one key and nothing else. The ship agent pins the two keys in **separate sets** (`PINNED_PUBLIC_KEYS` for updates, `COMPONENT_PUBLIC_KEYS` for components): the component verifier accepts only component keys and the update verifier accepts only update keys, so a compromise of this repository's release workflow can sign a component (and a web client) but can never sign an agent update, and the reverse. Tests in the ship agent cover both directions.

The key and the service account are created once, by a project owner (idempotent; the key ring and key can never be deleted, only their versions destroyed):

```sh
export PROJECT=botwarren-release LOCATION=europe-west2 KEYRING=botwarren-release KEY=component-signing
export SA=companion-signer@botwarren-release.iam.gserviceaccount.com
gcloud kms keys create "${KEY}" --keyring "${KEYRING}" --location "${LOCATION}" --project "${PROJECT}" \
  --purpose asymmetric-signing --default-algorithm ec-sign-ed25519 --protection-level software
gcloud iam service-accounts create companion-signer --project "${PROJECT}" \
  --display-name "Companion release signer (GitHub OIDC only)" --description "Can use ONE KMS key (component-signing); no keys, impersonable only via the botwarren-companion WIF provider"
gcloud kms keys add-iam-policy-binding "${KEY}" --keyring "${KEYRING}" --location "${LOCATION}" --project "${PROJECT}" \
  --member "serviceAccount:${SA}" --role roles/cloudkms.signerVerifier
# the public key, to be pinned (see below): the last 32 bytes of the DER of this PEM are the raw Ed25519 key
gcloud kms keys versions get-public-key 1 --key "${KEY}" --keyring "${KEYRING}" --location "${LOCATION}" --project "${PROJECT}"
```

**The public key is pinned.** `apps/companion/vendor/agent/src/update/keys.ts` (a copy of the ship agent's file) holds `COMPONENT_KEY_RAW_B64` = the raw 32-byte public key of `component-signing` version 1 (`Rv4WZoMAzdHQbQkIvHZpgGD/Pa6GXtwXN1Ql66vUVD4=`; SPKI `MCowBQYDK2VwAyEARv4WZoMAzdHQbQkIvHZpgGD/Pa6GXtwXN1Ql66vUVD4=`), and `COMPONENT_KEY_IS_PLACEHOLDER = false`. If the flag were ever `true` again, the signing scripts would refuse the key and the release workflow would fail in its first job, so nothing can be released with a key nobody holds. Compare it with the key any time: `gcloud kms keys versions get-public-key 1 --key component-signing ...` (the last 32 bytes of the DER).

**If the key is compromised:** the recovery-key holders sign a keys document revoking the id `kms-comp-2026a` (installed agents then refuse it), the key version is disabled (kill switch below), and a new agent release pins a new component key under a new id, `kms-comp-2026b` (a keys document can revoke a component key id but cannot add one), after which this repository's `KMS_KEY_ID` and `KMS_KEY_VERSION` switch to it. The verifiers take a list, so both ids may be pinned during the overlap.

Then let this repository, and only this repository, impersonate `companion-signer`. What is added is **one workload identity provider** in the existing pool `github-release`, restricted to this repository, and **one impersonation binding** for it on `companion-signer` (not on `release-signer`). Run as a project owner of `botwarren-release`, after the repository exists:

```sh
export PROJECT=botwarren-release PROJECT_NUMBER=881108236417 POOL=github-release PROVIDER=botwarren-companion
export SA=companion-signer@botwarren-release.iam.gserviceaccount.com
export REPO=turbokast/botwarren-companion
export OWNER_ID=335585049
# The numeric repository id (not the name): a deleted and re-created repository of the same name is a different identity.
export REPO_ID=<COMPANION_REPO_ID>        # = $(gh api repos/${REPO} --jq .id)
# stop here unless both ids are what you expect
test "$(gh api repos/${REPO} --jq .id)" = "${REPO_ID}" && test "$(gh api repos/${REPO} --jq .owner.id)" = "${OWNER_ID}" && echo "ids match"

gcloud iam workload-identity-pools providers create-oidc "${PROVIDER}" \
  --location global --project "${PROJECT}" --workload-identity-pool "${POOL}" \
  --display-name "botwarren-companion release.yml" \
  --issuer-uri "https://token.actions.githubusercontent.com" \
  --attribute-mapping "google.subject=assertion.sub,attribute.repository_id=assertion.repository_id,attribute.repository_owner_id=assertion.repository_owner_id,attribute.environment=assertion.environment,attribute.ref=assertion.ref,attribute.job_workflow_ref=assertion.job_workflow_ref" \
  --attribute-condition "assertion.repository_id == '${REPO_ID}' && assertion.repository_owner_id == '${OWNER_ID}' && assertion.environment == 'release' && assertion.ref_type == 'tag' && assertion.ref.startsWith('refs/tags/v') && assertion.job_workflow_ref.startsWith('${REPO}/.github/workflows/release.yml@refs/tags/v')"

gcloud iam service-accounts add-iam-policy-binding "${SA}" --project "${PROJECT}" \
  --role roles/iam.workloadIdentityUser \
  --member "principalSet://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL}/attribute.repository_id/${REPO_ID}"
```

Read it back:

```sh
gcloud iam workload-identity-pools providers describe "${PROVIDER}" --location global --project "${PROJECT}" --workload-identity-pool "${POOL}" \
  --format="yaml(name,state,attributeCondition)"
gcloud iam service-accounts get-iam-policy "${SA}" --project "${PROJECT}"                  # exactly one workloadIdentityUser member: this repository id
gcloud iam service-accounts get-iam-policy release-signer@botwarren-release.iam.gserviceaccount.com --project "${PROJECT}"   # the ship agent's account: only the ship repository id, NOT this one
gcloud kms keys get-iam-policy component-signing --keyring botwarren-release --location europe-west2 --project "${PROJECT}"   # only companion-signer, signerVerifier
gcloud kms keys get-iam-policy manifest-signing --keyring botwarren-release --location europe-west2 --project "${PROJECT}"    # the agent-update key: companion-signer must NOT appear
```

The provider accepts a GitHub OIDC token only when **all** of this holds: repository id `<COMPANION_REPO_ID>` (this repository), owner id `335585049`, the workflow `turbokast/botwarren-companion/.github/workflows/release.yml` at a `refs/tags/v*` tag, and environment `release`. Pull requests, forks, branches, other workflows and other repositories are refused by Google. The provider's resource name is
`projects/881108236417/locations/global/workloadIdentityPools/github-release/providers/botwarren-companion`.

What the separation buys, honestly: a compromised release workflow in this repository could sign a malicious web client or component (that is what the gated environment, the reviewer, the alert e-mail and the kill switch are for), but it holds no capability over the ship agent's update key: the service account cannot use it, and the agent would reject a component key's signature on an update manifest anyway (and the reverse). The component key is revocable on its own (kill switch below; the agent's recovery-key trust document can revoke the id `kms-comp-2026a`) without touching agent updates.

### 3. Repository variables and secrets

Repository **variables** (public names, not secrets):

| Variable | Value |
|---|---|
| `GCP_WORKLOAD_IDENTITY_PROVIDER` | `projects/881108236417/locations/global/workloadIdentityPools/github-release/providers/botwarren-companion` |
| `GCP_SERVICE_ACCOUNT` | `companion-signer@botwarren-release.iam.gserviceaccount.com` |
| `RELEASE_SIGNING` | `kms` (set this last) |
| `RELEASE_EPOCH` | optional; the trust epoch, default 1. Must equal the ship agent's current epoch: the agent refuses a component manifest from another epoch |

Environment **`release`** (required reviewer, deployment tags limited to `v*`) **secrets** (only here, never repository or organisation secrets): `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_ENDPOINT` (`https://<account id>.r2.cloudflarestorage.com`). The token is scoped to the bucket `botwarren-downloads` with object read and write only. The same token as the ship repository's may be used; a separate token is better.

**Today there is one maintainer, so the reviewer is the same person who pushes the tag: the gate is a deliberate cooling-off step (a pause to look at the hashes and the diff), not two-person control, and nothing public may claim two-person release.**

## Verifying a release

```sh
sha256sum --check SHA256SUMS
gh attestation verify relay-context-X.Y.Z.tar.gz --repo turbokast/botwarren-companion
node apps/companion/scripts/verify-release.mjs <directory with the downloaded release files>      # in a checkout of this repository
```

`verify-release.mjs` trusts only the public component key pinned in `apps/companion/vendor/agent/src/update/keys.ts` (`kms-comp-2026a`; the same file as in the ship agent, whose agent-update key `kms-2026a` this tooling never accepts). It checks that `SHA256SUMS` lists exactly the files present with the right hashes, that the client manifest signature verifies (domain `botwarren-client-v1`) and every client file matches it, that the loader's SRI hash in `index.html` is the signed loader's, that the component manifest verifies with the ship agent's own verifier (domain `botwarren-component-v1`) and describes the zip, that the zip holds only the four allowed files, and that the relay image inputs contain exactly the signed client.

Builds are reproducible: check out the tag and run

```sh
export SOURCE_DATE_EPOCH="$(git log -1 --format=%ct)" GIT_COMMIT="$(git rev-parse HEAD)"
node --disable-warning=ExperimentalWarning apps/companion/client/scripts/build.mjs --out dist/client
node --disable-warning=ExperimentalWarning apps/companion/scripts/build-component.mjs --out dist/component
```

(Node.js 24, pnpm 11, `pnpm install --frozen-lockfile`). `dist/client/manifest.json` must equal the signed `client-manifest.json`, apart from the signature, and the zip must be byte-identical to the released `companion-X.Y.Z.zip`.

## The component signing key and the kill switch

Key facts: Google Cloud KMS, project `botwarren-release`, key ring `botwarren-release` (`europe-west2`), key `component-signing`, version 1, `EC_SIGN_ED25519`, software protection, non-exportable; used only by `companion-signer@botwarren-release.iam.gserviceaccount.com`; public key pinned as `kms-comp-2026a` in the ship agent and in `apps/companion/vendor/agent/src/update/keys.ts`:

```
kms-comp-2026a   MCowBQYDK2VwAyEARv4WZoMAzdHQbQkIvHZpgGD/Pa6GXtwXN1Ql66vUVD4=
```

It is **not** the ship agent's update-signing key (`kms-2026a`, key `manifest-signing`). The offline recovery keys (any two of three) belong to the agent's trust mechanism: they can revoke the id `kms-comp-2026a` for every installed agent and raise the trust epoch, and their custody and the recovery procedure are documented in the ship agent repository's `docs/RELEASING.md`. They cannot add component keys; a new component key needs a new agent release.

**Detection.** Every `AsymmetricSign` on the key is logged and e-mailed to the owner (the logging metric covers every key in the key ring). A Companion release makes two signing calls. **An e-mail with no release run in progress means the key was used by someone else: treat it as a compromise.**

**Kill switch.** Stop all Companion signing at once, without touching agent updates: `gcloud kms keys versions disable 1 --key component-signing --keyring botwarren-release --location europe-west2 --project botwarren-release`. To stop only this repository's access: `gcloud iam workload-identity-pools providers update-oidc botwarren-companion --location global --workload-identity-pool github-release --project botwarren-release --disabled`. To make installed agents refuse the key: a recovery-signed keys document revoking `kms-comp-2026a`.

**Emergency signing by the owner** (a fresh component manifest when CI is unavailable, or before the 90 days run out): build or fetch the component zip and the unsigned manifest, `node apps/companion/scripts/assemble-component-manifest.mjs --dir <build output> --out signed --previous <current manifest.json> --previous-sig <current manifest.json.sig>`, then `gcloud auth login` as the project owner and `node apps/companion/vendor/agent/scripts/component-sign.mjs --kms projects/botwarren-release/locations/europe-west2/keyRings/botwarren-release/cryptoKeys/component-signing/cryptoKeyVersions/1 --key-id kms-comp-2026a signed/manifest.json`; upload `manifest.json.sig` then `manifest.json` to `companion/`. The alert e-mail will arrive, which is expected.

## Blocking a bad release

To stop ship agents installing a version: assemble and sign a new component manifest that lists it (`assemble-component-manifest.mjs ... --block X.Y.Z`; later manifests carry `blocked` entries forward automatically), as in the emergency procedure above, and publish it. An agent never installs a blocked version. A copy that is already installed keeps running until the user turns it off on their account page or runs `botwarren companion remove`, so a release that must not keep running needs a fixed release as well.

## Owner actions still open (first release)

1. Create the repository and apply [REPO_SETTINGS.md](REPO_SETTINGS.md).
2. The `component-signing` key, the `companion-signer` service account and the pinned public key exist (above). Run the provider and binding commands with the real repository id; read back the provider and both policies.
3. Set the variables and the environment secrets; set `RELEASE_SIGNING=kms` last.
4. First release: use a pre-release tag (`v0.1.0` is already marked pre-release by the workflow) and check step 7 of "Cutting a release". The negative tests (pull request, fork, branch, other workflow, other repository all refused by Google) need a real GitHub OIDC token and were not run before this document was written.
5. Deploy the relay from the release ([RELAY.md](RELAY.md)) and check that `https://relay.botwarren.com/manifest.json` equals the release's `client-manifest.json`.
