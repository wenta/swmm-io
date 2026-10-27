/**
 * Positional EPA SWMM 5.2 INP fields.
 *
 * These descriptors cover unambiguous, common record layouts. SWMM also has
 * polymorphic, option-dependent, and free-form sections; those retain raw
 * access instead of pretending to have a universal positional schema.
 * The INP file itself remains the source of truth; no defaults or units are
 * invented, and a missing field is not silently substituted by a default.
 */
export type FieldType = 'text' | 'number' | 'integer';
export interface FieldDescriptor {
  readonly name: string;
  readonly type: FieldType;
}
export interface SectionSchema {
  readonly section: string;
  readonly fields: readonly FieldDescriptor[];
  /** A record can have additional positional fields or context-specific variants. */
  readonly variableLayout: boolean;
}

const N = (name: string): FieldDescriptor => ({name, type:'number'});
const I = (name: string): FieldDescriptor => ({name, type:'integer'});
const T = (name: string): FieldDescriptor => ({name, type:'text'});
// The first field is always the record key / reference ID except the special
// free-form sections which are intentionally not registered.
const defs: Readonly<Record<string, {f: readonly FieldDescriptor[]; variable?: boolean}>> = {
  OPTIONS: {f:[T('name'), T('value')],variable:true},
  REPORT: {f:[T('name'),T('value')],variable:true},
  FILES: {f:[T('name'),T('file'),T('mode')],variable:true},
  RAINGAGES: {f:[T('id'),T('format'),T('interval'),N('snowCatchFactor'),T('source'),T('sourceName'),T('station'),T('units')],variable:true},
  SUBCATCHMENTS: {f:[T('id'),T('rainGage'),T('outlet'),N('area'),N('imperviousPercent'),N('width'),N('slopePercent'),N('curbLength'),T('snowPack')]},
  SUBAREAS: {f:[T('id'),N('imperviousRoughness'),N('perviousRoughness'),N('imperviousDepressionStorage'),N('perviousDepressionStorage'),N('zeroStoragePercent'),T('routing'),N('routedPercent')]},
  // Infiltration field meanings depend on the global infiltration model;
  // call raw() for exact data or use with options() to interpret correctly.
  INFILTRATION: {f:[T('id'),T('parameter1'),T('parameter2'),T('parameter3'),T('parameter4'),T('parameter5')],variable:true},
  LID_CONTROLS: {f:[T('id'),T('layer'),T('parameter1'),T('parameter2'),T('parameter3'),T('parameter4'),T('parameter5')],variable:true},
  LID_USAGE: {f:[T('id'),T('lidProcess'),I('number'),N('area'),N('width'),N('initialSaturation'),N('imperviousTreated'),N('sendToPervious'),T('drainTo'),T('fromPervious')],variable:true},
  JUNCTIONS: {f:[T('id'),N('invertElevation'),N('maxDepth'),N('initialDepth'),N('surchargeDepth'),N('pondedArea')]},
  OUTFALLS: {f:[T('id'),N('invertElevation'),T('outfallType'),T('stageData'),T('gated'),T('routeTo')],variable:true},
  DIVIDERS: {f:[T('id'),N('invertElevation'),T('divertedLink'),T('dividerType'),T('parameter1'),T('parameter2'),T('parameter3'),N('maxDepth'),N('initialDepth'),N('surchargeDepth'),N('pondedArea')],variable:true},
  STORAGE: {f:[T('id'),N('invertElevation'),N('maxDepth'),N('initialDepth'),T('shape'),T('parameter1'),T('parameter2'),T('parameter3'),T('parameter4'),T('parameter5')],variable:true},
  CONDUITS: {f:[T('id'),T('fromNode'),T('toNode'),N('length'),N('roughness'),N('inletOffset'),N('outletOffset'),N('initialFlow'),N('maxFlow')]},
  PUMPS: {f:[T('id'),T('fromNode'),T('toNode'),T('pumpCurve'),T('status'),T('startupDepth'),T('shutoffDepth')]},
  ORIFICES: {f:[T('id'),T('fromNode'),T('toNode'),T('orificeType'),N('offset'),N('dischargeCoefficient'),T('gated'),N('openCloseTime')]},
  WEIRS: {f:[T('id'),T('fromNode'),T('toNode'),T('weirType'),N('crestHeight'),N('dischargeCoefficient'),T('gated'),N('endContraction'),N('endCoefficient'),T('surcharge')],variable:true},
  OUTLETS: {f:[T('id'),T('fromNode'),T('toNode'),N('offset'),T('outletType'),T('curveOrCoefficient'),T('exponent'),T('gated')],variable:true},
  XSECTIONS: {f:[T('id'),T('shape'),T('geometry1'),T('geometry2'),T('geometry3'),T('geometry4'),I('barrels'),T('culvertCode')],variable:true},
  LOSSES: {f:[T('id'),N('inletLoss'),N('outletLoss'),N('averageLoss'),T('flapGate'),N('seepage')]},
  COORDINATES: {f:[T('id'),N('x'),N('y')]},
  VERTICES: {f:[T('id'),N('x'),N('y')],variable:true},
  POLYGONS: {f:[T('id'),N('x'),N('y')],variable:true},
  SYMBOLS: {f:[T('id'),N('x'),N('y')]},
  TAGS: {f:[T('objectType'),T('id'),T('tag')],variable:true},
  POLLUTANTS: {f:[T('id'),T('units'),N('rainConcentration'),N('groundwaterConcentration'),N('rdiiConcentration'),N('decayCoefficient'),T('snowOnly'),T('coPollutant'),N('coFraction'),N('dwfConcentration')],variable:true},
  LANDUSES: {f:[T('id'),N('sweepingInterval'),N('availability'),N('lastSwept')]},
  COVERAGES: {f:[T('subcatchment'),T('landuse'),N('percent')],variable:true},
  LOADINGS: {f:[T('subcatchment'),T('pollutant'),N('buildup')],variable:true},
  BUILDUP: {f:[T('landuse'),T('pollutant'),T('function'),N('coefficient1'),N('coefficient2'),N('coefficient3'),T('normalizer')],variable:true},
  WASHOFF: {f:[T('landuse'),T('pollutant'),T('function'),N('coefficient1'),N('coefficient2'),N('sweepEfficiency'),N('bmpEfficiency')],variable:true},
  INFLOWS: {f:[T('node'),T('constituent'),T('timeSeries'),T('type'),N('multiplier'),N('scaleFactor'),N('baseline'),T('pattern')],variable:true},
  DWF: {f:[T('node'),T('constituent'),N('average'),T('pattern1'),T('pattern2'),T('pattern3'),T('pattern4')],variable:true},
  RDII: {f:[T('node'),T('uhGroup'),N('sewerArea')]},
  TIMESERIES: {f:[T('id'),T('dateOrTime'),T('timeOrValue'),T('value')],variable:true},
  CURVES: {f:[T('id'),T('curveTypeOrX'),T('xOrY'),T('y')],variable:true},
  PATTERNS: {f:[T('id'),T('patternTypeOrFactor'),T('factor1'),T('factor2'),T('factor3'),T('factor4'),T('factor5'),T('factor6')],variable:true},
  TRANSECTS: {f:[T('code'),T('value1'),T('value2'),T('value3'),T('value4')],variable:true},
  SNOWPACKS: {f:[T('id'),T('surface'),T('parameter1'),T('parameter2'),T('parameter3'),T('parameter4'),T('parameter5'),T('parameter6'),T('parameter7')],variable:true},
  GROUNDWATER: {f:[T('id'),T('aquifer'),T('node'),N('surfaceElevation'),N('unsaturatedZoneDepth'),N('initialWaterTable'),N('initialMoisture'),T('customExpression')],variable:true},
  AQUIFERS: {f:[T('id'),N('porosity'),N('wiltingPoint'),N('fieldCapacity'),N('conductivity'),N('conductivitySlope'),N('tensionSlope'),N('upperEvaporationFraction'),N('lowerEvaporationDepth'),N('lowerLossRate'),N('bottomElevation'),N('waterTableElevation'),N('unsaturatedMoisture')],variable:true},
  HYDROGRAPHS: {f:[T('id'),T('monthOrGage'),T('typeOrR'),T('rOrT'),T('tOrK'),T('k')],variable:true},
  INLET_USAGE: {f:[T('link'),T('inlet'),I('number'),N('cloggedPercent'),N('flowLimit'),N('height'),N('width'),T('placement')],variable:true},
  INLETS: {f:[T('id'),T('type'),T('parameter1'),T('parameter2'),T('parameter3'),T('parameter4'),T('parameter5')],variable:true},
  STREETS: {f:[T('id'),N('width'),N('gutterSlope'),N('roadSlope'),N('curbHeight'),N('roughness'),N('depressionDepth'),N('gutterWidth'),N('sides')],variable:true},
  TREATMENT: {f:[T('node'),T('pollutant'),T('expression')],variable:true},
  ADJUSTMENTS: {f:[T('variable'),T('monthOrFactor'),T('factor')],variable:true},
  EVAPORATION: {f:[T('source'),T('parameter1'),T('parameter2'),T('parameter3')],variable:true},
  TEMPERATURE: {f:[T('keyword'),T('parameter1'),T('parameter2'),T('parameter3')],variable:true},
  REPORTING: {f:[T('key'),T('value')],variable:true},
  MAP: {f:[T('property'),T('value1'),T('value2'),T('value3'),T('value4')],variable:true},
};
const schemaMap = new Map<string, SectionSchema>(Object.entries(defs).map(([section,{f,variable}]) => [section, {
  section, fields: f, variableLayout: variable ?? false
}]));
/** Known positional layouts; unknown/free-form sections still work via InpDocument.rows(). */
export function inpSchema(section: string): SectionSchema | undefined { return schemaMap.get(section.toUpperCase()); }
/** List registered sections (not a claim that every SWMM variant is type-safe). */
export function inpSchemas(): readonly SectionSchema[] { return [...schemaMap.values()]; }
/** A low-allocation way to resolve a known field position. */
export function inpFieldIndex(section: string, field: string): number {
  const desc = inpSchema(section);
  if (!desc) throw new RangeError(`No registered positional schema for [${section.toUpperCase()}]`);
  const index = desc.fields.findIndex(x => x.name === field);
  if (index < 0) throw new RangeError(`Unknown ${section.toUpperCase()} field '${field}'`);
  return index;
}
