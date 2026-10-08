# FSRS Adapter

Beta Life pins `ts-fsrs@5.4.2` (MIT), maintained at <https://github.com/open-spaced-repetition/ts-fsrs>. The adapter keeps engine calls in this module; React and tag selection do not reimplement FSRS updates.

The pinned version, algorithm name, and full `FSRSParameters` snapshot are stored with scheduler snapshots and confirmed review records. To upgrade, review the upstream changelog and official test vectors, update `FSRS_VERSION` and `package.json`, rebuild snapshots from confirmed review logs, and compare the old/new snapshots before replacing the cache.

`enable_fuzz` is disabled so fixed-date replay and tests remain deterministic. The default requested retention is `0.90`.
