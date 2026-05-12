---
name: supply-chain-attack-investigation
description: Structured workflow for investigating public software supply-chain attacks across local repositories, GitHub organizations, and CI/host fleets. Use when asked to assess exposure to compromised packages, malicious releases, package-manager attacks, GitHub Actions/OIDC abuse, or published IOC lists.
---

# Supply-Chain Attack Investigation

## Purpose

This skill guides a repeatable, evidence-preserving investigation for third-party supply-chain incidents. It is designed for incidents like compromised npm/PyPI packages, malicious package releases, poisoned GitHub Actions workflows, CI credential theft, and public IOC advisories.

The core pattern is:

1. Ingest public reporting and IOC sources.
2. Build a dedicated investigation folder.
3. Run a repository-side track.
4. Run or prepare a separate CI/host-side collector track.
5. Merge key conclusions into a scoped main report.

Do **not** modify remote repositories, revoke credentials, delete artifacts, or perform cleanup unless the user explicitly asks for that as a separate remediation task. This skill is for investigation and evidence collection.

## First Response: Scope Before Scanning

If the user has not already provided these details, ask for them before beginning substantial work. Do not guess paths, organizations, or credentials.

Ask for:

- Incident name or short label.
- Links to public reporting, advisories, IOC pages, or vendor posts.
- Any affected package lists: CSV, JSON, table, advisory text, SBOM export, lockfile package list, etc.
- Desired investigation output folder, or permission to create one using the date and incident name.
- Whether to scan local repositories.
  - If yes: repo root(s), whether to scan recursively or immediate children only, and whether the agent may run `git fetch` to inspect remote default branch metadata. Never run `git pull` unless explicitly requested.
- Whether to scan a GitHub organization.
  - If yes: org name and token source (`GITHUB_TOKEN`, `.env`, `gh auth`, etc.). Use read-only API/code search. Do not clone every repository.
- Whether to scan CI/host systems.
  - If yes: host/IP list or Tailscale CSV, SSH username, SSH key path, and whether the agent should run the fleet collector or only prepare tooling for the user to run.
- Explicit out-of-scope repos, systems, paths, or networks.
- Audience: internal-only, customer-facing, or both.

If credentials are unavailable, prepare scripts and instructions so the user can execute the relevant collector and return the outputs.

## Investigation Folder Structure

Prefer this structure unless the user gives a different one:

```text
<investigation-root>/
├── <date> <incident-name> supply chain investigation.md
├── source-material/
│   ├── reporting-links.md
│   ├── extracted-reporting/
│   ├── iocs.json
│   └── affected-packages.csv
├── repo-investigation/
│   ├── <date> Repository investigation - <incident-name>.md
│   ├── README.md
│   ├── tools/
│   └── raw JSON/CSV outputs
└── ci-investigation/
    ├── <date> CI host IOC collector investigation.md
    ├── README.md
    ├── tools/
    └── full-fleet-<timestamp>/
```

Keep repo-side and CI/host-side tracks separate. The main report should summarize both and link to detailed artifacts.

## Source / IOC Ingestion

Read the full public reporting, not just snippets. Save useful source material under `source-material/` where appropriate.

Extract and normalize:

- Affected ecosystems, package names, namespaces/scopes, and versions.
- Malicious files and paths.
- Hashes.
- Domains, URLs, IPs, user agents, API endpoints.
- Suspicious commit authors, accounts, branch names, commit hashes.
- Persistence paths and config locations.
- Credential targets and likely blast radius.
- Attack window / publication timestamps.
- Vendor recommended actions.

Create or update `source-material/iocs.json` using this shape:

```json
{
  "incident": "example-incident",
  "text_iocs": ["malicious.example", "bad_commit_hash"],
  "file_names": ["payload.js", "setup.mjs"],
  "hashes": {"sha256": ["..."]},
  "domains": ["malicious.example"],
  "urls": ["https://malicious.example/payload"],
  "suspicious_authors": ["attacker@example.com"],
  "persistence_paths": [".claude/", ".vscode/tasks.json"],
  "workflow_risk_terms": ["pull_request_target", "id-token: write"]
}
```

Affected package CSVs should preferably use columns like:

```csv
Ecosystem,Namespace,Name,Version,Published,Detected
npm,@scope,package,1.2.3,,
pypi,,package,1.2.3,,
```

Every incident is different. Treat bundled tools as starting points to adapt, not as proof that the exact same checks are sufficient.

## Repository-Side Track

### Local repositories

If scanning local repos:

- Ask the user whether to scan immediate child repos, recursively discovered repos, or a supplied list.
- Report repositories by GitHub remote/org names when available, not local machine paths.
- Do not run `git pull`. If current default-branch freshness matters and credentials are available, ask before running `git fetch` or remote metadata checks.
- Start with targeted files for speed and relevance:
  - npm: `package.json`, `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, `npm-shrinkwrap.json`, `bun.lock*`
  - Python: `pyproject.toml`, `poetry.lock`, `uv.lock`, `requirements*.txt`, `Pipfile*`, `setup.py`, `setup.cfg`
  - other manifests/lockfiles relevant to the incident
  - `.github/workflows/`, `.buildkite/`, `ci/`, `scripts/`, `Dockerfile*`
  - persistence/config paths named in the IOC source
- Separate findings into:
  - confirmed exact affected package-version hits
  - package-name references without affected version confirmation
  - malware-specific IOC hits
  - generic workflow-risk terms
- Be careful with lockfiles: a package name and an affected version string appearing somewhere in the same file is not automatically a package-version hit. Confirm the version belongs to that package.

### GitHub organization repositories

If scanning a GitHub org:

- Prefer read-only GitHub API/code search. Do not clone every repo.
- Enumerate repositories through the API.
- Run GitHub code search for strongest IOC strings first.
- Fetch only likely default-branch files: manifests, lockfiles, workflows, CI scripts, Dockerfiles, persistence/config paths.
- Preserve raw outputs, errors, and truncated tree details.
- State clearly that this reviews default-branch contents unless history scanning was explicitly performed.

## CI / Host Collector Track

Keep this separate from repository review.

Before running any remote collector, confirm with the user:

- target host list / CSV
- SSH username
- SSH key path or agent availability
- parallelism and timeout
- output directory
- that read-only remote execution is approved

If credentials are not present, prepare the tools and README and ask the user to run them.

Collectors should gather evidence, not secrets. By default, do **not** collect token values or secret listings. Prefer:

- IOC filename hits.
- Hashes of matching IOC files.
- Text IOC hits in targeted paths.
- Persistence/config hits.
- Suspicious git-author commits.
- Tool versions and host metadata.
- Process/network/DNS context when useful.

Do not run cleanup, deletion, revocation, package installs, or system mutation.

## Reporting Requirements

Use three layers:

1. **Main report** — concise summary and current conclusion.
2. **Repository report** — detailed repo-side methodology, results, artifacts, limitations.
3. **CI-host report** — detailed host-side methodology, results, artifacts, limitations.

Use scoped wording:

- Good: “No evidence was found in the reviewed repositories under the implemented checks.”
- Good: “No host-side IOC hits were found across 52 of 52 CI hosts reached by the collector.”
- Bad: “No impact” unless all relevant evidence sources actually support that.
- Bad: “Clean” without scope.

Always distinguish:

- local repository findings
- GitHub org/default-branch findings
- CI/host findings
- centralized logs not reviewed
- developer workstations not reviewed
- transient/ephemeral environments not reviewed

## Suggested Workflow

1. Ask the scoping questions.
2. Create the investigation folder.
3. Save source links and affected package lists.
4. Extract IOCs into `iocs.json`.
5. Copy or adapt scripts from this skill’s `tools/` folder into the investigation’s `repo-investigation/tools/` and `ci-investigation/tools/` folders.
6. Run local repo scans if in scope.
7. Run GitHub org scans if in scope and token is available.
8. Prepare or execute CI-host collection if in scope.
9. Review raw outputs manually enough to avoid false positives.
10. Write standalone repo and CI reports.
11. Update the main report with scoped conclusions and artifact references.

## Included Tooling

This skill includes generic starter scripts under `tools/`:

- `local_repo_supply_chain_scan.py` — targeted local repo scan using `iocs.json` and optional affected package CSV.
- `github_org_supply_chain_scan.py` — read-only GitHub org default-branch scan using API token.
- `ci_host_remote_probe.py` — read-only remote host probe template.
- `run_ci_host_collection.py` — SSH fleet runner for CSV or host list.
- `local_host_collector.sh` — single-host local evidence package collector.

These scripts are templates. Adapt them for incident-specific IOCs, package ecosystems, and evidence requirements.

## Customer/Internal Wording Pattern

For customer-facing or internal assurance notes, use language like:

> We reviewed the currently available public reporting and IOC guidance, scanned the in-scope repositories and default-branch GitHub organization contents, and performed a separate host-side IOC sweep across the reviewed CI fleet. We found no evidence of affected package-version usage or malware-specific IOC presence in those reviewed evidence sources. This conclusion is scoped to the repositories, default branches, and hosts reviewed; it does not independently prove that no developer workstation, historical commit, transient build environment, package cache, or centralized log source ever encountered the affected artifacts.

That precision matters. It prevents a useful investigation from becoming an overclaim.
