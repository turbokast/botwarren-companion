# Repository settings

This records how `turbokast/botwarren-companion` is to be configured on GitHub and why, so the settings can be reviewed and rebuilt. Most of them are not files in the repository, so they are written down here. They mirror the ship agent repository ([botwarren-ship](https://github.com/turbokast/botwarren-ship), its `docs/REPO_SETTINGS.md`) except where this page says otherwise. If a setting differs from this page, one of them is wrong: fix the setting or send a pull request.

## General

| Setting | Value | Why |
|---|---|---|
| Description | Opt-in, end-to-end encrypted remote approvals for coding agents: the companion, the relay and the signed web client. The relay and the server carry ciphertext only. | The one-sentence promise |
| Website | <https://botwarren.com/trust.html#companion> | The trust page explains what the Companion reads and who can see what |
| Topics | `ai-agents`, `ai-coding`, `claude-code`, `end-to-end-encryption`, `hpke`, `mcp`, `nodejs`, `open-source`, `privacy`, `remote-approvals`, `typescript` | Discoverability |
| Issues | on (issue forms, blank issues off) | Bugs and accepted feature work |
| Discussions | on | Questions and ideas go here, not in issues ([SUPPORT.md](../SUPPORT.md)) |
| Wiki, Projects | off | Documentation lives in the repository, where it is reviewed |
| Merge methods | squash only (merge commits and rebase merging off) | Linear history; the squash commit keeps every `Signed-off-by` line |
| Automatically delete head branches | on | No stale branches |
| Always suggest updating pull request branches | on | |
| Allow auto-merge | on | |
| Require contributors to sign off on web-based commits | on | Web edits carry a DCO sign-off too |

## Security and analysis

| Feature | State | Notes |
|---|---|---|
| Dependency graph | on | Needed by the dependency review |
| Dependabot alerts, security updates, version updates | on (`.github/dependabot.yml`: Actions, npm, the relay Dockerfile) | Security updates ignore the 7 day cool-down |
| Secret scanning and push protection | on | A push that contains a recognised secret is blocked. The tests assemble their fake secrets at run time so that none sits in the source |
| Private vulnerability reporting | on | [SECURITY.md](../SECURITY.md) |
| Code scanning | CodeQL **by workflow** (`.github/workflows/codeql.yml`), not GitHub's "default setup" (which must stay "not configured") | Reviewed in pull requests, pinned, also scans the workflow files |

## Actions

| Setting | Value | Why |
|---|---|---|
| Allowed actions | selected: GitHub-owned actions, plus `pnpm/action-setup`, `google-github-actions/auth`, `ossf/scorecard-action`, `zizmorcore/zizmor-action` | The fewest third parties that the workflows need |
| Require actions to be pinned to a full commit SHA | on | A moved tag cannot change what runs |
| Default workflow token | read-only; workflows may not approve pull requests | Each job asks for what it needs |
| Fork pull request workflows | need approval for first-time contributors | |
| Environment `release` | required reviewer (the maintainer), deployments limited to `v*` tags and the `main` branch (the scheduled re-sign); holds the R2 secrets | [RELEASING.md](RELEASING.md) |
| Variables | `GCP_WORKLOAD_IDENTITY_PROVIDER`, `GCP_SERVICE_ACCOUNT`, `RELEASE_SIGNING` (= `kms`), optional `RELEASE_EPOCH` | Names of public resources, not secrets |
| Secrets | `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_ENDPOINT`, **only** in the `release` environment | Never repository or organisation secrets |

## Ruleset `protect-main` (the default branch)

| Rule | |
|---|---|
| Restrict deletions | on |
| Block force pushes (non-fast-forward) | on |
| Require linear history | on |
| Require a pull request before merging | on; **squash** only; stale approvals dismissed on a new push; conversations must be resolved; required approving reviews: **0** (see "The honest limits") |
| Require status checks | `typecheck and test (ubuntu-latest)`, `reproducible build`, `Analyze (javascript-typescript)`, `Analyze (actions)`, `dependency-review`, `dco` (branches need not be up to date). **Add** `typecheck and test (macos-latest)`, `typecheck and test (windows-latest)` and `web client in a browser` once each has been green for a week: the macOS and Windows paths have had little manual testing, and a flaky required check blocks every pull request |
| Require code scanning results | CodeQL; errors, and security alerts of high severity or higher, block the merge |
| Bypass | the repository **Admin** role (always) |

A second ruleset, `protect-release-tags`, stops `v*` tags being moved or deleted. Only an organisation admin can bypass it.

The `Workflow lint` and `Scorecard` jobs are deliberately **not** required (the first runs only when workflows change, the second is a scheduled report). If a job is renamed in a workflow, update the required check name here and in the ruleset, or merging stops.

### The honest limits

* **There is one maintainer.** GitHub does not let an author approve their own pull request, so requiring one approving review would make the project impossible to maintain alone. The ruleset requires a pull request and green checks, and **no** approving review. The moment a second maintainer exists, raise it to 1 and turn on code-owner review (`.github/CODEOWNERS` is already in place; see [GOVERNANCE.md](../GOVERNANCE.md)).
* **The admin role can bypass the ruleset**, including pushing straight to `main`. This is on purpose: it keeps the maintainer from being locked out, and it is how the public tree is synchronised from the private development repository. These rules protect against mistakes and against everyone else, not against the maintainer's own account. Two-factor authentication is required for the organisation.
* The OpenSSF Scorecard will report lower marks for "Code-Review" and "Contributors" for the same reason, and that is accurate.
* The `release` environment's reviewer is the person who pushes the tag. It is a cooling-off step, not two-person control.

## Labels

`bug`, `enhancement`, `documentation`, `security` (hardening work; vulnerabilities are reported privately), `good first issue`, `help wanted`, `question`, `dependencies` and `ci`, with the same colours as the ship agent repository.

## Rebuilding these settings (`gh api`)

Run as an organisation owner with the `gh` CLI. These commands follow the ship agent repository's recorded settings and GitHub's REST documentation; they have not been run against this repository yet, so read each setting back after applying it (`gh api repos/${REPO}/...`, and the Settings pages) and fix this page if GitHub answered differently. The repository-role id of Admin in a ruleset bypass list is `5`; the id of an organisation admin actor is `1`.

```sh
REPO=turbokast/botwarren-companion
gh repo create "${REPO}" --public --description "Opt-in, end-to-end encrypted remote approvals for coding agents: the companion, the relay and the signed web client. The relay and the server carry ciphertext only." --homepage "https://botwarren.com/trust.html#companion"

gh api -X PATCH "repos/${REPO}" --input - <<'JSON'
{ "has_issues": true, "has_discussions": true, "has_wiki": false, "has_projects": false,
  "allow_squash_merge": true, "allow_merge_commit": false, "allow_rebase_merge": false,
  "squash_merge_commit_title": "PR_TITLE", "squash_merge_commit_message": "COMMIT_MESSAGES",
  "delete_branch_on_merge": true, "allow_update_branch": true, "allow_auto_merge": true, "web_commit_signoff_required": true,
  "security_and_analysis": { "secret_scanning": { "status": "enabled" }, "secret_scanning_push_protection": { "status": "enabled" } } }
JSON
gh api -X PUT "repos/${REPO}/topics" --input - <<'JSON'
{ "names": ["ai-agents","ai-coding","claude-code","end-to-end-encryption","hpke","mcp","nodejs","open-source","privacy","remote-approvals","typescript"] }
JSON
gh api -X PUT "repos/${REPO}/vulnerability-alerts"
gh api -X PUT "repos/${REPO}/automated-security-fixes"
gh api -X PUT "repos/${REPO}/private-vulnerability-reporting"

# Actions: selected actions, pinned to a SHA, read-only default token, fork PR approval for first-time contributors
gh api -X PUT "repos/${REPO}/actions/permissions" -F enabled=true -f allowed_actions=selected -F sha_pinning_required=true
gh api -X PUT "repos/${REPO}/actions/permissions/selected-actions" --input - <<'JSON'
{ "github_owned_allowed": true, "verified_allowed": false,
  "patterns_allowed": ["pnpm/action-setup@*","google-github-actions/auth@*","ossf/scorecard-action@*","zizmorcore/zizmor-action@*"] }
JSON
gh api -X PUT "repos/${REPO}/actions/permissions/workflow" -f default_workflow_permissions=read -F can_approve_pull_request_reviews=false
gh api -X PUT "repos/${REPO}/actions/permissions/fork-pr-contributor-approval" -f approval_policy=first_time_contributors

# the protected `release` environment: reviewer = the maintainer, tags v* only
ME=$(gh api users/Angry-Potato --jq .id)
gh api -X PUT "repos/${REPO}/environments/release" --input - <<JSON
{ "reviewers": [ { "type": "User", "id": ${ME} } ], "deployment_branch_policy": { "protected_branches": false, "custom_branch_policies": true } }
JSON
gh api -X POST "repos/${REPO}/environments/release/deployment-branch-policies" -f name='v*' -f type=tag
# the scheduled re-sign (resign.yml) runs on main in the same environment, behind the same approval (see RELEASING.md, "The scheduled re-sign"; Google's provider condition must allow it too)
gh api -X POST "repos/${REPO}/environments/release/deployment-branch-policies" -f name='main' -f type=branch
# secrets live ONLY in the environment (prompted; never put a value on the command line or in a file in the repository)
gh secret set R2_ACCESS_KEY_ID --env release --repo "${REPO}"
gh secret set R2_SECRET_ACCESS_KEY --env release --repo "${REPO}"
gh secret set R2_ENDPOINT --env release --repo "${REPO}"
# variables (after the Google Cloud step in RELEASING.md); RELEASE_SIGNING last
gh variable set GCP_WORKLOAD_IDENTITY_PROVIDER --repo "${REPO}" --body "projects/881108236417/locations/global/workloadIdentityPools/github-release/providers/botwarren-companion"
gh variable set GCP_SERVICE_ACCOUNT --repo "${REPO}" --body "companion-signer@botwarren-release.iam.gserviceaccount.com"
gh variable set RELEASE_SIGNING --repo "${REPO}" --body kms
```

The rulesets:

```sh
gh api -X POST "repos/${REPO}/rulesets" --input - <<'JSON'
{ "name": "protect-main", "target": "branch", "enforcement": "active",
  "conditions": { "ref_name": { "include": ["~DEFAULT_BRANCH"], "exclude": [] } },
  "bypass_actors": [ { "actor_id": 5, "actor_type": "RepositoryRole", "bypass_mode": "always" } ],
  "rules": [
    { "type": "deletion" },
    { "type": "non_fast_forward" },
    { "type": "required_linear_history" },
    { "type": "pull_request", "parameters": { "required_approving_review_count": 0, "dismiss_stale_reviews_on_push": true, "require_code_owner_review": false,
        "require_last_push_approval": false, "required_review_thread_resolution": true, "allowed_merge_methods": ["squash"] } },
    { "type": "required_status_checks", "parameters": { "strict_required_status_checks_policy": false, "required_status_checks": [
        { "context": "typecheck and test (ubuntu-latest)" }, { "context": "reproducible build" },
        { "context": "Analyze (javascript-typescript)" }, { "context": "Analyze (actions)" },
        { "context": "dependency-review" }, { "context": "dco" } ] } },
    { "type": "code_scanning", "parameters": { "code_scanning_tools": [ { "tool": "CodeQL", "security_alerts_threshold": "high_or_higher", "alerts_threshold": "errors" } ] } }
  ] }
JSON
gh api -X POST "repos/${REPO}/rulesets" --input - <<'JSON'
{ "name": "protect-release-tags", "target": "tag", "enforcement": "active",
  "conditions": { "ref_name": { "include": ["refs/tags/v*"], "exclude": [] } },
  "bypass_actors": [ { "actor_id": 1, "actor_type": "OrganizationAdmin", "bypass_mode": "always" } ],
  "rules": [ { "type": "deletion" }, { "type": "non_fast_forward" }, { "type": "update" } ] }
JSON
```

Labels: `gh label create <name> --color <hex> --description "<text>" --repo "${REPO}"` (or `gh label edit` for the defaults that exist). Create the `release` environment and the `protect-release-tags` ruleset **before** the first tag is pushed; push the first `main` content before turning `protect-main` on (the admin bypass is how the public tree is synchronised).

## Owner actions (cannot be done through the API)

1. **Social preview image** (Settings, General, Social preview): upload one when there is a brand image for the Companion.
2. **OpenSSF Best Practices badge**: sign in at <https://www.bestpractices.dev> with GitHub and answer the questionnaire (the ship agent's answers in its `docs/OPENSSF_BEST_PRACTICES.md` are a starting point), then add the badge to the README.
3. **Discussions categories**: the defaults are in place; categories cannot be created through the API.
4. **Second maintainer**: when there is one, make them the `release` reviewer with "prevent self-review" on, require 1 approving review in `protect-main`, and turn on code-owner review.
