# <DATE> <INCIDENT> supply-chain investigation

| Investigators | Impacted Systems | Impacted Users |
| :---- | :---- | :---- |
| <names> | <scoped conclusion> | <N/A or description> |

## Summary

<Why the investigation was opened and what public reporting triggered it.>

Relevant public reporting:

- <link>

The investigation covered:

1. Repository-side review of <local repos / GitHub org / etc.>.
2. CI/host-side review of <hosts/fleet>, if performed.

Current conclusion: <precise scoped conclusion>.

## External attack details and IOCs

<Concise summary of attack mechanics, affected packages, credential targets, persistence, hashes/domains/files.>

## Repository-side investigation

Detailed artifacts:

- `repo-investigation/<report>.md`
- `repo-investigation/README.md`
- `repo-investigation/tools/`
- `repo-investigation/*.json`

Summary:

- Local repositories scanned: <n>
- GitHub org repositories enumerated: <n>
- Confirmed affected package-version hits: <n>
- Malware-specific IOC hits: <n>

<Interpretation.>

## CI-host investigation

Detailed artifacts:

- `ci-investigation/<report>.md`
- `ci-investigation/README.md`
- `ci-investigation/full-fleet-<timestamp>/`

Summary:

- Hosts targeted: <n>
- Hosts reached successfully: <n>
- Failures: <n>
- IOC file hits: <n>
- IOC text hits: <n>
- Persistence hits: <n>

<Interpretation.>

## Current conclusion

<Scoped conclusion across evidence sources reviewed.>

This conclusion is scoped to <repos/default branches/hosts/etc.>. It does not prove <unreviewed sources>.

## Recommended next steps

1. <retain artifacts / review logs / harden workflows / rotate if evidence emerges>
