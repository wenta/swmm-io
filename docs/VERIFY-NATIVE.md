# Native EPA SWMM comparison (opt-in)

**Purpose:** avoid circular tests in which `swmm-io` writes and verifies its own binary data. Validate against an independent numerical reference. We do **not** bundle third-party hydraulic model fixtures without checking redistribution rights.

## Quick path with PySWMM

In an isolated Python environment with a compatible platform:

```sh
python -m venv .venv
. .venv/bin/activate
pip install pyswmm
python tools/export-reference-pyswmm.py path/to/model.out reference.json --periods 10
```

PySWMM's `Output` functions wrap the native EPA SWMM output API. The exporter takes the first node and first link ID and outputs two series (node depth, link flow). It uses `end_exclusive=True`; the reader's interval convention is also `[start,end)`. Review the installed PySWMM version if its API changes.

Compare in Node:

```sh
npm run build
node tools/compare-reference.mjs path/to/model.out reference.json
```

The comparison uses an absolute tolerance `1e-6 * max(1, abs(expected))`. For exact bitwise float32 comparisons adapt the script to compare IEEE754 payloads.

This is deliberately a **minimum** independent check, not complete verification. Expand to every object type, every variable (including pollutants), timestamps, units, multiple versions, missing/invalid values, simulations with warnings, and non-ASCII IDs. Check that native and TypeScript readers agree on the element order.

### Current prerelease status

- Synthetic binary fixture tests: executed in `npm test`.
- Original real-world fixture download harness: `node test/validate-real.mjs --download [--large]` (requires network).
- PySWMM output-reference export: implemented, **not executed** in this environment.
- Full native parity: **NOT CERTIFIED**.

Official source: https://github.com/USEPA/Stormwater-Management-Model
Output API: https://github.com/USEPA/Stormwater-Management-Model/tree/develop/src/outfile
