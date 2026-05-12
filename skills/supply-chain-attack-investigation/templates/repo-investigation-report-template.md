# <DATE> Repository investigation - <INCIDENT>

## Scope

Repository scope:

- Local repositories: <roots/list/in scope or not>
- GitHub organization: <org/in scope or not>
- Branch/history scope: <default branch / checked-out local state / history>

This review did not modify remote repositories and did not clone all organization repositories unless explicitly stated.

## IOC sources

- <links/files>

## Methodology

### Local repository scan

<How repos were discovered, what files were scanned, what scripts were used.>

### GitHub organization scan

<API/code search approach, target file classes, token source, repo count, errors/truncation handling.>

## Findings

### Confirmed affected package-version hits

<None or table.>

### Malware-specific IOC hits

<None or table.>

### Package-name references without affected version confirmation

<Optional.>

### Workflow-risk terms

<Optional; keep separate from compromise evidence.>

## Artifacts generated

- `<file>`

## Limitations

- Default-branch only unless stated.
- Local checkouts may not reflect latest remote state unless fetched/reviewed.
- Repository evidence cannot prove host/package-cache/ephemeral-runner absence.

## Bottom line

<Scoped repo-side conclusion.>
