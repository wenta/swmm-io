#!/usr/bin/env python3
"""Optional independently generated numerical reference via PySWMM / EPA output API.

Requires `pip install pyswmm`. No library-runtime Python dependency.
Input: .out from a real SWMM simulation. Output: JSON for compare-reference.mjs.
This is NOT run by default because PySWMM may not be installed. Install and
execute in a separate environment to provide an independent oracle.
"""
import argparse
import json
from pyswmm import Output
from swmm.toolkit.shared_enum import NodeAttribute, LinkAttribute


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('outfile')
    parser.add_argument('reference_json')
    parser.add_argument('--periods', type=int, default=10)
    args = parser.parse_args()
    if args.periods < 1:
        parser.error('periods must be positive')
    checks = []
    with Output(args.outfile) as out:
        # PySWMM Output is a wrapper around EPA SWMM Output API; each returned
        # value is independently obtained rather than recomputed by swmm-io.
        cases = [
            ('node', next(iter(out.nodes)), 'depth', NodeAttribute.INVERT_DEPTH, out.node_series),
            ('link', next(iter(out.links)), 'flow', LinkAttribute.FLOW_RATE, out.link_series),
        ]
        for kind, element_id, attribute, enum, method in cases:
            values = method(element_id, enum, start_index=0,
                            end_index=args.periods, end_exclusive=True)
            checks.append({
                'kind': kind,
                'object': element_id,
                'attribute': attribute,
                'values': [float(value) for value in values.values()],
            })
    with open(args.reference_json, 'w', encoding='utf-8') as handle:
        json.dump({'origin': 'PySWMM EPA SWMM Output API', 'checks': checks}, handle, indent=2)
    print(f'Wrote {len(checks)} independently measured series to {args.reference_json}')


if __name__ == '__main__':
    main()
