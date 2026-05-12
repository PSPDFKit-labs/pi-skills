# <DATE> CI host IOC collector investigation - <INCIDENT>

## Scope

Host scope:

- <fleet/source/filter>

The collector was read-only and did not perform cleanup, credential revocation, or remote repository modification.

## Methodology

<CSV/host list parsing, SSH execution, remote probe, output structure.>

Run artifact directory:

- `ci-investigation/full-fleet-<timestamp>/`

Run metadata:

- Generated at: <timestamp>
- Host count: <n>
- Parallelism: <n>
- Timeout: <n>

## Checks performed

- IOC filenames: <list>
- Hashes: <list>
- Text IOC strings: <list>
- Persistence/config paths: <list>
- Suspicious git authors: <list>
- Host/process/tool/DNS context: <yes/no>

## Results

- Hosts targeted: <n>
- Hosts reached successfully: <n>
- SSH / collection failures: <n>
- Hosts with IOC file paths: <n>
- Hosts with IOC text hits: <n>
- Hosts with persistence hits: <n>
- Hosts with suspicious git-author hits: <n>
- Hosts with collector flags: <n>

<Interpretation.>

## Artifacts generated

- `run_metadata.json`
- `summary.csv`
- `summary.json`
- `failures.json`
- `hosts/*.json`

## Limitations

- Host-side point-in-time evidence only.
- Does not prove absence from transient containers/workspaces that no longer exist.
- Does not review centralized cloud/GitHub/proxy/EDR logs unless separately done.

## Bottom line

<Scoped CI-host conclusion.>
