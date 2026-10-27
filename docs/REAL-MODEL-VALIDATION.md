# Real-world model validation status

The user independently ran **swmm-io v0.6.0** on a MacBook Air M4 and provided the terminal output on October 26, 2026. It records:

| Test mode | Passed / total | Notable data |
|---|---:|---|
| `--download` | 8/8 | Norfolk Brambleton/Hague; EPA standard INP and OUT fixtures |
| `--large` | 10/10 | 4,023,184-byte INP and 53,759,218-byte OUT (EPA 17100 H&H) |
| `--stress` | 11/11 | 66,203,137-byte INP (NCIMM 275000 H&H) with 91,270 nodes, 93,312 links, 75,177 subcatchments |

The M4 300k-link synthetic benchmark (Node 20.19.5, 10k queried IDs × four properties) reported lazy reads ~21.56 ms, batched ~12.95 ms, numeric ~11.93 ms, cached numeric ~3.23 ms and cache materialization ~139.07 ms.

These earlier test logs are historical evidence only. For the current release, run the supplied real-world test harness and independent EPA Output API comparisons on locally available fixtures; the distribution does not embed third-party model files.

Steps to close the remaining release gate:

1. Run `node test/validate-real.mjs --download --stress` on the previously downloaded files. The script can reuse local fixtures.
2. Run `tools/measure-model.mjs --inp <66MB.inp>` and `--out <54MB.out> --index` and capture `maximum resident set size` with `/usr/bin/time -l` on macOS.
3. Generate independent reference data with PySWMM via `tools/export-reference-pyswmm.py` and verify with `tools/compare-reference.mjs` (see `docs/VERIFY-NATIVE.md`).
4. Repeat against SWMM 5.1 and 5.2-generated outputs with pollutants and link type variations; inspect discrepancies before claiming full compatibility.

Full semantic coverage and independent native numerical parity have not yet been demonstrated for this prerelease.
