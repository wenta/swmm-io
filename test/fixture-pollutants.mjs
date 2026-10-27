const MAGIC = 516114522;
/** Independent binary construction covering real EPA layout with pollutant names and units. */
export function createPollutantOut({ periods = 4, paddingLinks = 0, errorCode = 0 } = {}) {
  const nSub = 1, nNodes = 2, nLinks = 1 + paddingLinks, nPollutants = 1;
  const enc = new TextEncoder();
  const perPeriod = 8 + 4 * (nSub * 9 + nNodes * 7 + nLinks * 6 + 15);
  const b = new Uint8Array(1500 + perPeriod * periods + nLinks * 40);
  const v = new DataView(b.buffer);
  let at = 0;
  const i32 = n => { v.setInt32(at, n, true); at += 4; };
  const f32 = n => { v.setFloat32(at, n, true); at += 4; };
  const f64 = n => { v.setFloat64(at, n, true); at += 8; };
  const name = n => { const x = enc.encode(n); i32(x.length); b.set(x, at); at += x.length; };
  i32(MAGIC); i32(52004); i32(3); i32(nSub); i32(nNodes); i32(nLinks); i32(nPollutants);
  const idPos = at;
  name('S1'); name('J1'); name('J2'); name('L1');
  for(let i=0;i<paddingLinks;i++) name('D'+i);
  name('TSS');
  i32(1); // pollutant units code, appended before InputStartPos
  const propsPos = at;
  i32(1); i32(1); f32(12.5); // subcatch area
  i32(3); i32(0); i32(2); i32(3);
  for (let i=0; i<2; i++) { i32(0); f32(10 + i); f32(3); }
  i32(5); i32(0); i32(4); i32(4); i32(3); i32(5);
  for (let i=0; i<nLinks; i++) { i32(0); f32(1); f32(2); f32(3); f32(50); }
  for (const n of [9,7,6,15]) { i32(n); for(let i=0;i<n;i++) i32(i); }
  f64(44000); i32(300);
  const resultsPos = at;
  for(let p=0; p<periods; p++) {
    f64(44000 + (p+1)*300/86400);
    for(let j=0;j<9;j++) f32(j===8 ? 10+p : j+p);
    for(let i=0;i<nNodes;i++) for(let j=0;j<7;j++) f32(j===6 ? 20 + 10*i + p : 100*i + j + p);
    for(let i=0;i<nLinks;i++) for(let j=0;j<6;j++) f32(j===5 ? 30 + 10*i + p : 100*i + j + p);
    for(let j=0;j<15;j++) f32(j+p);
  }
  i32(idPos); i32(propsPos); i32(resultsPos); i32(periods); i32(errorCode); i32(MAGIC);
  return b.slice(0,at);
}
