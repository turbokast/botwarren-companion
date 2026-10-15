# Governance

This is a small project with one maintainer. This page says honestly how decisions are made, so that contributors know what to expect.

## Who decides

The project is maintained by **TurboKast Ltd**, which owns the Botwarren service this program works with. Today the only maintainer is **Liam Humphreys** (see [MAINTAINERS.md](MAINTAINERS.md)). He reviews and merges every change, cuts every release and has the final say. There is no steering committee, no voting and no second approver, and this page does not pretend otherwise: in particular, release approval is by that single person (a deliberate cooling-off step, not two-person control; see [docs/RELEASING.md](docs/RELEASING.md)).

## What does not change

Some decisions are not up for a case-by-case vote because they are the reason the project exists. A change that breaks one of them will be declined, however well it is written:

* the relay and the Botwarren website carry **ciphertext only** and never hold a device key;
* a paired device can **approve, deny or send a preset reply** to the request pending now, and nothing else: no free text, no terminal output, no file transfer;
* the web client and the component run only if they are covered by a validly signed manifest with matching hashes;
* no telemetry, no analytics, no third-party origin in the web client.

The full list is in [CONTRIBUTING.md](CONTRIBUTING.md#ground-rules).

## How changes are made

1. Open an issue or a [Discussion](https://github.com/turbokast/botwarren-companion/discussions) for anything larger than a small fix, so you do not spend time on something that cannot be merged. Changes to the protocol, the envelope, pairing, signing or what a device may do always start with an issue.
2. Send a pull request with tests and a sign-off on every commit ([DCO](CONTRIBUTING.md#licence-and-sign-off-dco)). CI, CodeQL and the dependency review must pass.
3. The maintainer reviews. Expect a first response within a week; this is not a full-time job for anyone. If a pull request goes quiet for a month it may be closed, and can be reopened.
4. Merges are squash merges to `main`, so history stays linear. Releases are tagged from `main` and described in [CHANGELOG.md](CHANGELOG.md).

## Becoming a maintainer

Contributors who have made several substantial, well-tested contributions and who show good judgement about the ground rules above can be invited to review and then to merge. The invitation is the maintainer's decision. Once there is a second maintainer, release approval and changes under `.github/`, `apps/companion/src/protocol/`, `apps/companion/client/`, `apps/companion/scripts/` and `apps/relay/` will need the second person's review, and this page will be updated.

## Continuity

If the maintainer stops working on the project, TurboKast Ltd can name a new one, and because the code is Apache-2.0 anyone may fork it. The signing key for this project's releases is a non-exportable key in a Google Cloud KMS project (it is on nobody's laptop); it is not the key that signs the ship agent's updates. The offline recovery keys that can revoke it (through the ship agent's trust mechanism) are currently held by the one maintainer, which is a single point of failure that this page does not hide (the procedure is in the ship agent repository's release documentation).

## Independent review

No independent security review has been done. When one is commissioned, its scope and its findings will be published in this repository.

## Conduct and disagreements

Everyone follows the [Code of Conduct](CODE_OF_CONDUCT.md). Reports go to support@turbokast.com. If you disagree with a decision, say so in the issue with your reasons; the maintainer will explain the decision, and may change it.

## Changing this page

Changes to governance are proposed by pull request like any other change and decided by the maintainer, after at least a week of open discussion.
