# Getting help

## Questions, ideas and show-and-tell

Use **[GitHub Discussions](https://github.com/turbokast/botwarren-companion/discussions)**. Search first; someone may already have asked. Good places to start:

* *Q&A*: pairing problems, "why does my phone not get the request", "what can a paired device do"
* *Ideas*: a change you would like to see, another agent tool to support
* *Show and tell*: what you built with it

Before asking, these usually answer it:

* [README](README.md): how it works, the security model in plain words, install and pairing, the Claude Code requirements
* [docs/PROTOCOL.md](docs/PROTOCOL.md) and [docs/CLIENT_SECURITY.md](docs/CLIENT_SECURITY.md)
* `botwarren-companion status`, `botwarren-companion log` and `botwarren-companion claude doctor` on your computer
* The trust page: <https://botwarren.com/trust.html#companion>

## Bugs

Open an [issue](https://github.com/turbokast/botwarren-companion/issues/new/choose) with the bug form: it asks for the Companion version, your operating system, your Claude Code version and where it goes wrong. **Never paste secrets, tokens, keys, pairing codes or messages from your agents**; redact them.

## Security and privacy problems

Do **not** open a public issue. If the Companion, the relay or the web client exposed, accepted or sent something it should not have, or you found a weakness in pairing, the signed client, the release workflow or the install path, follow [SECURITY.md](SECURITY.md): email support@turbokast.com with the subject `SECURITY: botwarren-companion`, or use GitHub's private vulnerability reporting on this repository.

## The hosted Botwarren service and your account

Problems with botwarren.com itself (your account, whether the Companion is offered to you, the public page) and with the hosted relay's availability are not handled in this repository. Email support@turbokast.com.

## Response times

This is a small project with one maintainer, so there is no service level. Security reports are acknowledged within 3 working days (see [SECURITY.md](SECURITY.md)); questions and issues are usually answered within a week.
