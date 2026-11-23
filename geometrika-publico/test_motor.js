/* Pruebas del motor de análisis (node test_motor.js). Imprime PASS/FAIL y sale con código 1 si algo falla. */
'use strict';
const MLMotor = require('./modelab-motor.js');
const T = MLMotor._t;

let fallos = 0, total = 0;
async function prueba(nombre, fn) {
  total++;
  const t0 = Date.now();
  try { await fn(); console.log('PASS  ' + nombre + '  (' + (Date.now() - t0) + ' ms)'); }
  catch (e) { fallos++; console.log('FAIL  ' + nombre + '  -> ' + (e && e.message)); if (process.env.VERBOSO && e && e.stack) console.log(e.stack); }
}
function ok(c, m) { if (!c) throw new Error(m || 'la condición no se cumple'); }
function cerca(a, b, tol, m) { if (!(Math.abs(a - b) <= tol)) throw new Error((m || 'valor') + ': esperado ' + b + ' ±' + tol + ', obtenido ' + a); }

// --- Generador de datos sintéticos con semilla fija
function rngSeed(seed) { let a = seed >>> 0; const r = function () { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; r.normal = function () { let u = 0; while (u === 0) u = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r()); }; return r; }

function datasetReg(n, p, seed, conCat) {
  const r = rngSeed(seed), cols = [], rows = [];
  for (let j = 0; j < p; j++) cols.push({ name: 'x' + (j + 1), label: 'Variable ' + (j + 1) });
  if (conCat) { cols.push({ name: 'zona', label: 'Zona' }); }
  cols.push({ name: 'y', label: 'Resultado', unit: 'u' });
  for (let i = 0; i < n; i++) {
    const x = []; for (let j = 0; j < p; j++) x.push(r.normal());
    let zona = null, ef = 0;
    if (conCat) { const u = r(); zona = u < 0.4 ? 'A' : (u < 0.75 ? 'B' : 'C'); ef = zona === 'B' ? 1 : (zona === 'C' ? -1 : 0); }
    const y = 3 + 2 * x[0] - 1.5 * x[1] + 0.5 * x[2] + ef + 0.5 * r.normal();
    rows.push(x.concat(conCat ? [zona] : []).concat([y]));
  }
  return { cols: cols, rows: rows };
}
function datasetClf(n, p, seed, K) {
  const r = rngSeed(seed), cols = [], rows = [];
  for (let j = 0; j < p; j++) cols.push({ name: 'x' + (j + 1), label: 'Variable ' + (j + 1) });
  cols.push({ name: 'y', label: 'Clase' });
  for (let i = 0; i < n; i++) {
    const x = []; for (let j = 0; j < p; j++) x.push(r.normal());
    let y;
    if (K === 2) { const s = 2 * x[0] - 2 * x[1] + 0.3 * r.normal(); y = s > 0 ? 'si' : 'no'; }
    else { const k = Math.floor(r() * K); x[0] += 4 * Math.cos(2 * Math.PI * k / K); x[1] += 4 * Math.sin(2 * Math.PI * k / K); y = 'clase' + k; }
    rows.push(x.concat([y]));
  }
  return { cols: cols, rows: rows };
}
function datasetClusters(nPor, seed) {
  const r = rngSeed(seed), centros = [[0, 0, 0, 0], [8, 8, 0, 0], [0, 8, 8, 8]], rows = [], real = [];
  for (let c = 0; c < 3; c++) for (let i = 0; i < nPor; i++) { rows.push(centros[c].map(function (m) { return m + r.normal(); })); real.push(c); }
  // mezclar de forma determinista
  const idx = rows.map(function (_, i) { return i; }), q = rngSeed(seed + 1);
  for (let i = idx.length - 1; i > 0; i--) { const j = Math.floor(q() * (i + 1)); const t = idx[i]; idx[i] = idx[j]; idx[j] = t; }
  return { ds: { cols: [{ name: 'a' }, { name: 'b' }, { name: 'c' }, { name: 'd' }], rows: idx.map(function (i) { return rows[i]; }) }, real: idx.map(function (i) { return real[i]; }) };
}
function sinNoFinitos(o, ruta) {
  ruta = ruta || '$';
  if (typeof o === 'number') { if (!isFinite(o)) throw new Error('Valor no finito en ' + ruta); return; }
  if (o && typeof o === 'object') Object.keys(o).forEach(function (k) { sinNoFinitos(o[k], ruta + '.' + k); });
}
const ETAPAS_SUP = ['prep', 'entrenamiento', 'calibracion', 'evaluacion', 'diagnostico'];
const ETAPAS_NOSUP = ['prep', 'reduccion', 'ajuste', 'validacion', 'interpretacion'];
function ids(res) { return res.etapas.map(function (e) { return e.id; }); }

(async function () {
  // ======================= 1. Funciones numéricas base =======================
  await prueba('parseNum limpia texto numérico', function () {
    cerca(T.parseNum('1,234.5'), 1234.5, 1e-9); cerca(T.parseNum('12%'), 12, 1e-9); cerca(T.parseNum(' 7 '), 7, 1e-9);
    cerca(T.parseNum('$1,000'), 1000, 1e-9); cerca(T.parseNum('-3.5'), -3.5, 1e-9);
    ok(isNaN(T.parseNum('abc')) && isNaN(T.parseNum('')) && isNaN(T.parseNum(null)), 'no numéricos deben dar NaN');
  });
  await prueba('distribuciones: t, normal, chi-cuadrada', function () {
    cerca(T.tCDF(2.3534, 3), 0.95, 2e-4, 't(3)'); cerca(T.normCDF(1.96), 0.975, 2e-4, 'normal');
    cerca(T.chi2CDF(5.991, 2), 0.95, 2e-4, 'chi2'); cerca(T.tInv(0.975, 10), 2.2281, 1e-3, 'tInv');
    cerca(T.chi2Inv(0.99, 4), 13.2767, 1e-3, 'chi2Inv'); cerca(T.normInv(0.975), 1.95996, 1e-4, 'normInv');
  });
  await prueba('Jacobi: A·v = λ·v y Cholesky/inversa', function () {
    const A = [[4, 1, 0.5], [1, 3, 0.2], [0.5, 0.2, 2]].map(function (f) { return Float64Array.from(f); });
    const e = T.jacobi(A, 3);
    for (let k = 0; k < 3; k++) for (let i = 0; i < 3; i++) { let s = 0; for (let j = 0; j < 3; j++) s += A[i][j] * e.vecs[j][k]; cerca(s, e.vals[k] * e.vecs[i][k], 1e-9, 'autovector'); }
    ok(e.vals[0] >= e.vals[1] && e.vals[1] >= e.vals[2], 'orden descendente');
    const inv = T.invertir(A, 3); let d = 0; for (let j = 0; j < 3; j++) d += A[0][j] * inv[j][0]; cerca(d, 1, 1e-9, 'A·A⁻¹');
    ok(T.cholesky(A, 3) !== null, 'cholesky');
  });

  // ======================= 2. Perfilado =======================
  await prueba('perfilar: tipos, faltantes, atípicos, texto numérico', function () {
    const r = rngSeed(1), rows = [];
    for (let i = 0; i < 200; i++) rows.push([
      r.normal() * 10 + 50, Math.floor(r() * 4) * 1000 + Math.floor(r() * 3), r() < 0.5 ? 0 : 1, ['Norte', 'sur', 'Sur ', 'Este'][Math.floor(r() * 4)],
      'id' + i, i % 10 === 0 ? null : (1000 + i).toLocaleString('en-US') + '.5', 7, i < 100 ? 'NA' : String(r() * 5), Math.floor(r() * 5) + 1, i === 5 ? 500 : r().toFixed(3), i % 7 === 0 ? '12%' : ' ' + (3 + i % 4) + ' ']);
    const ds = { cols: [{ name: 'ingreso', label: 'Ingreso medio', unit: 'MXN' }, { name: 'ent' }, { name: 'bin' }, { name: 'zona' }, { name: 'id' }, { name: 'txtnum' }, { name: 'const' }, { name: 'mitad' }, { name: 'likert' }, { name: 'outl' }, { name: 'pct' }], rows: rows };
    const p = MLMotor.perfilar(ds), por = {}; p.forEach(function (x) { por[x.name] = x; });
    ok(p.length === 11, 'una entrada por columna');
    ok(por.ingreso.tipo === 'num' && por.ingreso.label === 'Ingreso medio' && por.ingreso.n === 200, 'num');
    ok(por.ent.tipo === 'int', 'int (más de 10 distintos): ' + por.ent.tipo);
    ok(por.bin.tipo === 'bin', 'bin'); ok(por.zona.tipo === 'cat' && por.zona.unicos === 3, 'cat con variantes unificadas: ' + por.zona.unicos);
    ok(por.id.tipo === 'texto', 'texto con >50 % únicos');
    ok(por.txtnum.tipo === 'num' && por.txtnum.faltantes === 20 && por.txtnum.max > 1000, 'texto numérico limpiado');
    ok(por.const.constante === true, 'constante');
    ok(por.mitad.faltantes === 100 && Math.abs(por.mitad.pctFaltantes - 50) < 1e-9, 'faltantes por "NA"');
    ok(por.likert.tipo === 'cat' && por.likert.ordinal === true, 'entera ≤10 y n>50 → cat ordinal');
    ok(por.outl.outliersIQR >= 1 && por.outl.outliersZ >= 1, 'atípicos detectados');
    ok(por.pct.numerica === true && por.pct.max === 12, 'porcentajes como número');
    ok(por.ingreso.muestra.length === 5 && por.zona.categorias.length === 3, 'muestra y categorías');
    ['mediana', 'q1', 'q3', 'sesgo', 'curtosis', 'sd', 'media', 'min', 'max'].forEach(function (k) { ok(typeof por.ingreso[k] === 'number', 'campo ' + k); });
  });
  await prueba('perfilar: columna todo vacía y dataset pequeño no revientan', function () {
    const p = MLMotor.perfilar({ cols: [{ name: 'a' }, { name: 'b' }], rows: [[null, 1], [undefined, 2], [NaN, 3]] });
    ok(p[0].constante === true && p[0].n === 0 && p[0].faltantes === 3, 'todo vacío');
    ok(MLMotor.perfilar({ cols: [{ name: 'a' }], rows: [] }).length === 1, 'sin filas');
  });

  // ======================= 3. Catálogo y sugerencias =======================
  await prueba('catalogoPrep tiene todas las listas y opciones {id,nombre,desc}', function () {
    const c = MLMotor.catalogoPrep;
    const esperado = { faltantes: 7, outliers: 5, escalado: 4, codificacion: 3, transformacion: 4, duplicados: 2, colineales: 3, constantes: 2, columnaFaltantes: 3 };
    Object.keys(esperado).forEach(function (k) { ok(Array.isArray(c[k]) && c[k].length === esperado[k], k + ' debe tener ' + esperado[k]); c[k].forEach(function (o) { ok(o.id && o.nombre && o.desc, 'opción completa en ' + k); }); });
    ok(Array.isArray(c.formatos) && c.formatos.length >= 1, 'formatos');
    ok(c.columnaFaltantes.map(function (o) { return o.id; }).join() === 'conservar,eliminar_si_>40%,eliminar_si_>60%', 'ids columnaFaltantes');
  });
  await prueba('sugerirPrep razona: faltantes, sesgo, atípicos, escalado', function () {
    const r = rngSeed(3), rows = [];
    for (let i = 0; i < 600; i++) rows.push([r.normal(), Math.exp(r.normal() * 1.2), i % 10 === 0 ? null : r.normal(), i < 400 ? null : r.normal(), r() < 0.5 ? 'a' : 'b', r.normal() + (i === 3 ? 40 : 0), i]);
    const ds = { cols: [{ name: 'n' }, { name: 'sesgada' }, { name: 'f10' }, { name: 'f67' }, { name: 'cat' }, { name: 'ext' }, { name: 'y' }], rows: rows };
    const perf = MLMotor.perfilar(ds);
    const s = MLMotor.sugerirPrep(perf, { enfoque: 'sup', y: 'y', x: ['n', 'sesgada', 'f10', 'f67', 'cat', 'ext'], n: 600 });
    const g = s.global;
    ['faltantes', 'outliers', 'escalado', 'codificacion', 'transformacion', 'duplicados', 'colineales', 'constantes', 'columnaFaltantes'].forEach(function (k) { ok(g[k] && g[k].id && g[k].razon.length > 10, 'global.' + k); });
    ok(g.columnaFaltantes.id === 'eliminar_si_>60%' || g.columnaFaltantes.id === 'eliminar_si_>40%', 'columna con 67 % faltante se elimina: ' + g.columnaFaltantes.id);
    ok(g.transformacion.id === 'log1p_si_sesgo' || g.transformacion.id === 'yeo_si_sesgo', 'sesgo>1 → transformar: ' + g.transformacion.id);
    ok(s.porColumna.sesgada.transformacion === 'log1p_si_sesgo', 'la columna sesgada positiva usa log1p');
    ok(g.escalado.id === 'estandar', 'escalado estándar');
    ok(s.resumen.length >= 5 && s.porColumna.sesgada && s.porColumna.sesgada.transformacion, 'resumen y por columna');
    const sa = MLMotor.sugerirPrep(perf, { enfoque: 'nosup', y: null, x: ['n', 'ext'], n: 600, metodo: 'anomalias' });
    ok(sa.global.outliers.id === 'ninguno', 'anomalías no recorta');
    const st = MLMotor.sugerirPrep(perf, { enfoque: 'sup', y: 'y', x: ['n', 'ext'], n: 600, metodo: 'bosque_reg' });
    ok(st.global.escalado.id === 'ninguno', 'árboles no escalan');
  });
  await prueba('sugerirMetodos: regresión, binaria, multiclase, conteos y no supervisado', function () {
    function perfDe(ds) { const p = MLMotor.perfilar(ds), o = {}; p.forEach(function (x) { o[x.name] = x; }); return o; }
    function xs(p, ys) { return Object.keys(p).filter(function (k) { return k !== ys; }).map(function (k) { return p[k]; }); }
    function chk(lista, n) {
      ok(lista.length === n, 'cantidad de métodos ' + lista.length);
      lista.forEach(function (m) {
        ['id', 'nombre', 'familia', 'razon', 'desc'].forEach(function (k) { ok(typeof m[k] === 'string' && m[k].length > 0 || (k === 'razon' && m.aplica === false), k + ' en ' + m.id); });
        ok(typeof m.aplica === 'boolean' && typeof m.recomendado === 'boolean', 'flags'); ok(Array.isArray(m.ventajas) && Array.isArray(m.limites), 'listas');
        ok(['bajo', 'medio', 'alto'].indexOf(m.recursos.tiempo) >= 0 && ['baja', 'media', 'alta'].indexOf(m.recursos.memoria) >= 0 && m.recursos.etiqueta, 'recursos');
        ok(typeof m.datosMinimos === 'number', 'datosMinimos');
      });
      ok(lista.filter(function (m) { return m.recomendado; }).length <= 1, 'máximo un recomendado');
      lista.forEach(function (m) { if (m.recomendado) ok(m.aplica, 'recomendado debe aplicar'); });
    }
    const pr = perfDe(datasetReg(300, 4, 5, true));
    let l = MLMotor.sugerirMetodos('sup', pr.y, xs(pr, 'y'), 300); chk(l, 12);
    const get = function (l, id) { return l.filter(function (m) { return m.id === id; })[0]; };
    ok(get(l, 'ols').aplica && get(l, 'ols').tipoRespuesta === 'regresion' && get(l, 'ols').recomendado, 'ols recomendado en regresión');
    ok(!get(l, 'logistica').aplica && /predice categor/.test(get(l, 'logistica').razon), 'clasificación no aplica a Y continua');
    const pc = perfDe(datasetClf(300, 4, 6, 2));
    l = MLMotor.sugerirMetodos('sup', pc.y, xs(pc, 'y'), 300); chk(l, 12);
    ok(get(l, 'logistica').aplica && get(l, 'logistica').tipoRespuesta === 'binaria' && get(l, 'logistica').recomendado, 'logística binaria recomendada');
    ok(!get(l, 'ols').aplica && /predice un n/.test(get(l, 'ols').razon), 'regresión no aplica a Y categórica');
    const pm = perfDe(datasetClf(300, 4, 7, 4));
    l = MLMotor.sugerirMetodos('sup', pm.y, xs(pm, 'y'), 300);
    ok(get(l, 'logistica').tipoRespuesta === 'multiclase' && get(l, 'bosque_clf').aplica, 'multiclase');
    // conteos
    const r = rngSeed(9), rows = []; for (let i = 0; i < 300; i++) { const a = r.normal(); rows.push([a, Math.max(0, Math.round(20 + 8 * a + 3 * r.normal()))]); }
    const pk = perfDe({ cols: [{ name: 'a' }, { name: 'y', label: 'Visitas' }], rows: rows });
    l = MLMotor.sugerirMetodos('sup', pk.y, [pk.a], 300);
    ok(get(l, 'ols').aplica && /Poisson/.test(get(l, 'ols').razon), 'nota de Poisson para conteos');
    // n pequeño y más variables que observaciones
    l = MLMotor.sugerirMetodos('sup', pr.y, xs(pr, 'y'), 12);
    ok(!get(l, 'ols').aplica && /al menos/.test(get(l, 'ols').razon), 'n < mínimo');
    const wide = datasetReg(40, 38, 10, false), pw = perfDe(wide);
    l = MLMotor.sugerirMetodos('sup', pw.y, xs(pw, 'y'), 40);
    ok(!get(l, 'ols').aplica && get(l, 'ridge').aplica, 'ols no aplica con p ≈ n; ridge sí');
    l = MLMotor.sugerirMetodos('nosup', null, xs(pr, 'y'), 300); chk(l, 6);
    ok(l.every(function (m) { return m.tipoRespuesta === 'nosup'; }) && l.some(function (m) { return m.recomendado; }), 'nosup con recomendación');
    l = MLMotor.sugerirMetodos('sup', null, xs(pr, 'y'), 300);
    ok(l.every(function (m) { return !m.aplica; }), 'sin Y nada aplica');
  });

  // ======================= 4. OLS: coeficientes y p-valores de referencia =======================
  await prueba('OLS: p-valores coinciden con cálculo a mano (regresión simple clásica)', function () {
    const X = [1, 2, 3, 4, 5].map(function (v) { return Float64Array.of(v); }), y = Float64Array.from([2, 4, 5, 4, 5]);
    const m = T.olsAjustar(X, y);
    cerca(m.b0, 2.2, 1e-9, 'intercepto'); cerca(m.b[0], 0.6, 1e-9, 'pendiente');
    // a mano: RSS=2.4, s²=0.8, Sxx=10 → EE pendiente = sqrt(0.08); EE intercepto = sqrt(0.8·(1/5+9/10))
    cerca(m.se[1], Math.sqrt(0.08), 1e-9, 'EE pendiente'); cerca(m.se[0], Math.sqrt(0.8 * 1.1), 1e-9, 'EE intercepto');
    const F3 = function (t) { const u = t / Math.sqrt(3); return 0.5 + (Math.atan(u) + u / (1 + u * u)) / Math.PI; }; // CDF exacta t con 3 g.l.
    const t1 = 0.6 / Math.sqrt(0.08), t0 = 2.2 / Math.sqrt(0.88);
    cerca(m.t[1], t1, 1e-9, 't pendiente'); cerca(m.p[1], 2 * (1 - F3(t1)), 1e-9, 'p pendiente'); cerca(m.p[0], 2 * (1 - F3(t0)), 1e-9, 'p intercepto');
    cerca(m.p[1], 0.1240, 5e-4, 'p pendiente ≈ 0.124 (referencia publicada)'); cerca(m.p[0], 0.1015, 1e-3, 'p intercepto ≈ 0.101');
    ok(m.df === 3, 'grados de libertad');
  });
  await prueba('OLS vía correr recupera coeficientes conocidos (±0.1) e intervalos', async function () {
    const ds = datasetReg(1500, 5, 11, true);
    const res = await MLMotor.correr({ enfoque: 'sup', y: 'y', x: ['x1', 'x2', 'x3', 'x4', 'x5', 'zona'], metodo: 'ols', semilla: 42, prop_prueba: 0.2, folds: 5, prep: { global: { escalado: 'estandar', transformacion: 'ninguna', outliers: 'ninguno', faltantes: 'mediana', colineales: 'ninguno', duplicados: 'ninguno', constantes: 'eliminar', codificacion: 'onehot', columnaFaltantes: 'conservar' } } }, ds);
    const c = {}; res.coeficientes.forEach(function (k) { c[k.nombre] = k; });
    cerca(c.x1.coef, 2, 0.1, 'x1'); cerca(c.x2.coef, -1.5, 0.1, 'x2'); cerca(c.x3.coef, 0.5, 0.1, 'x3');
    cerca(c['zona=B'].coef, 1, 0.15, 'zona B'); cerca(c['zona=C'].coef, -1, 0.15, 'zona C'); cerca(c['(Intercepto)'].coef, 3, 0.15, 'intercepto (zona A de referencia)');
    ok(c.x4.p > 0.001 && c.x1.p < 1e-6, 'p-valores: x1 significativa'); ok(c.x1.ic95[0] < 2 && 2 < c.x1.ic95[1], 'IC 95 % contiene el verdadero');
    ok(res.metricas.prueba.r2 > 0.9, 'R² prueba alto: ' + res.metricas.prueba.r2);
    ok(res.importancias[0].var === 'Variable 1' && res.importancias[0].valor === 100, 'variable más importante x1');
    ok(res.tipoY === 'regresion' && res.prep.nTrain + res.prep.nTest === 1500, 'partición');
  });

  // ======================= 5. Ausencia de fuga =======================
  await prueba('sin fuga: imputación y escala se ajustan solo con entrenamiento (prep directo)', function () {
    const r = rngSeed(21), rows = [];
    for (let i = 0; i < 150; i++) { const test = i >= 100; const v = test ? 1000 + r.normal() : r.normal() * 2 + 10; rows.push([(!test && i % 25 === 0) || (test && i % 5 === 0) ? null : v, r.normal()]); }
    const cols = T.leerDataset({ cols: [{ name: 'a' }, { name: 'b' }], rows: rows });
    const tr = []; for (let i = 0; i < 100; i++) tr.push(i); const te = []; for (let i = 100; i < 150; i++) te.push(i);
    const g = { faltantes: 'media', outliers: 'ninguno', escalado: 'estandar', codificacion: 'onehot', transformacion: 'ninguna', duplicados: 'ninguno', colineales: 'ninguno', constantes: 'eliminar', columnaFaltantes: 'conservar' };
    const pa = T.ajustarPrep(cols, tr, { g: g, pc: {} });
    const obs = []; for (let i = 0; i < 100; i++) if (rows[i][0] !== null) obs.push(rows[i][0]);
    const mu = obs.reduce(function (s, x) { return s + x; }, 0) / obs.length;
    cerca(pa.modelo.esc.c[0], mu, 1e-9, 'el centro de la escala es el promedio del ENTRENAMIENTO');
    ok(pa.modelo.esc.c[0] < 20, 'no se contaminó con la prueba (~1000)');
    const ap = T.aplicarPrep(pa.modelo, te, false);
    const iFalt = te.findIndex(function (i) { return rows[i][0] === null; });
    cerca(ap.Xu[iFalt][0], mu, 1e-9, 'faltante de prueba se rellena con el promedio del entrenamiento');
    ok(ap.X[iFalt][0] === 0 || Math.abs(ap.X[iFalt][0]) < 1e-9, 'y queda en 0 tras escalar con la escala del entrenamiento');
    ok(ap.X[1][0] > 100, 'los datos de prueba se escalan con la escala del entrenamiento (valores grandes)');
  });
  await prueba('sin fuga: alterar las filas de prueba no cambia nada del entrenamiento (correr)', async function () {
    const ds = datasetReg(600, 4, 31, false);
    ds.rows.forEach(function (f, i) { if (i % 17 === 0) f[0] = null; });
    const cfg = { enfoque: 'sup', y: 'y', x: ['x1', 'x2', 'x3', 'x4'], metodo: 'ridge', semilla: 7, prop_prueba: 0.25, folds: 4, prep: { global: { faltantes: 'media', escalado: 'estandar', transformacion: 'ninguna', outliers: 'iqr_recortar', colineales: 'ninguno', duplicados: 'ninguno', constantes: 'eliminar', codificacion: 'onehot', columnaFaltantes: 'conservar' } } };
    const a = await MLMotor.correr(cfg, ds);
    const test = new Set(a.predicciones.idx);
    const ds2 = { cols: ds.cols, rows: ds.rows.map(function (f, i) { return test.has(i) ? f.map(function (v, j) { return (j < 4 && v !== null) ? v * 50 + 1e4 : v; }) : f.slice(); }) };
    const b = await MLMotor.correr(cfg, ds2);
    ok(a.prep.nTrain === b.prep.nTrain, 'mismo entrenamiento');
    cerca(a.metricas.entrenamiento.rmse, b.metricas.entrenamiento.rmse, 1e-12, 'RMSE de entrenamiento idéntico');
    cerca(a.metricas.cv.media.rmse, b.metricas.cv.media.rmse, 1e-12, 'validación cruzada idéntica');
    ok(JSON.stringify(a.hiperparametros.elegidos) === JSON.stringify(b.hiperparametros.elegidos), 'mismos hiperparámetros');
    ok(Math.abs(a.metricas.prueba.rmse - b.metricas.prueba.rmse) > 1e-6, 'la prueba sí cambia');
    ok(a.predicciones.idx.every(function (i) { return a.predicciones.idx.indexOf(i) >= 0; }) && a.predicciones.idx.length === a.prep.nTest, 'idx de prueba');
  });
  await prueba('semilla: mismo resultado con la misma semilla y distinto con otra', async function () {
    const ds = datasetReg(400, 4, 41, false);
    const cfg = function (s) { return { enfoque: 'sup', y: 'y', x: ['x1', 'x2', 'x3', 'x4'], metodo: 'bosque_reg', semilla: s, folds: 3 }; };
    const a = await MLMotor.correr(cfg(5), ds), b = await MLMotor.correr(cfg(5), ds), c = await MLMotor.correr(cfg(6), ds);
    ok(JSON.stringify(a.predicciones) === JSON.stringify(b.predicciones), 'reproducible');
    ok(JSON.stringify(a.predicciones.idx) !== JSON.stringify(c.predicciones.idx), 'otra semilla, otra partición');
  });
  await prueba('partición estratificada conserva proporciones de clase', async function () {
    const r = rngSeed(51), rows = [];
    for (let i = 0; i < 500; i++) { const pos = r() < 0.1; rows.push([r.normal() + (pos ? 2 : 0), r.normal(), pos ? 'raro' : 'comun']); }
    const res = await MLMotor.correr({ enfoque: 'sup', y: 'y', x: ['a', 'b'], metodo: 'logistica', semilla: 1, prop_prueba: 0.3 }, { cols: [{ name: 'a' }, { name: 'b' }, { name: 'y' }], rows: rows });
    const frac = res.predicciones.real.filter(function (v) { return v === 'raro'; }).length / res.predicciones.real.length;
    const fracTot = rows.filter(function (f) { return f[2] === 'raro'; }).length / 500;
    cerca(frac, fracTot, 0.02, 'proporción de la clase rara en prueba');
  });

  // ======================= 6. Los 12 métodos supervisados de punta a punta =======================
  const dsReg = datasetReg(500, 6, 61, true), dsBin = datasetClf(500, 5, 62, 2), dsMul = datasetClf(600, 4, 63, 3);
  const xReg = ['x1', 'x2', 'x3', 'x4', 'x5', 'x6', 'zona'];
  function chkSup(res, tipo, metodo) {
    ok(res.enfoque === 'sup' && res.tipoY === tipo && res.metodo === metodo && res.nombreMetodo, 'cabecera');
    ok(ids(res).join() === ETAPAS_SUP.join(), 'etapas: ' + ids(res).join());
    res.etapas.forEach(function (e) { ok(typeof e.ms === 'number' && e.detalle.length > 0, 'etapa con ms y detalle: ' + e.id); });
    ok(res.prep.pasos.length > 2 && res.prep.nTrain > 0 && res.prep.nTest > 0 && res.prep.columnasFinales.length > 0 && Array.isArray(res.prep.descartadas), 'prep');
    ok(res.metricas.entrenamiento && res.metricas.prueba && res.metricas.cv.media && Array.isArray(res.metricas.cv.folds), 'métricas');
    ok(res.importancias.length > 0 && res.importancias[0].valor === 100 && res.importancias.every(function (i, k) { return k === 0 || i.valor <= res.importancias[k - 1].valor; }), 'importancias ordenadas');
    ok(res.hiperparametros && res.hiperparametros.elegidos && Array.isArray(res.hiperparametros.rejilla), 'hiperparámetros');
    ok(res.predicciones.idx.length === res.prep.nTest && res.predicciones.real.length === res.predicciones.pred.length, 'predicciones');
    ok(res.curvaAprendizaje.n.length >= 3, 'curva de aprendizaje con puntos: ' + res.curvaAprendizaje.n.length);
    ok(res.kpis.length >= 4 && res.kpis.length <= 6 && res.kpis.every(function (k) { return k.id && k.etiqueta && ['bueno', 'medio', 'malo', 'neutro'].indexOf(k.tono) >= 0 && k.formato; }), 'kpis');
    ok(res.hallazgos.length >= 3 && res.hallazgos.every(function (h) { return typeof h === 'string' && h.length > 10; }), 'hallazgos');
    ok(res.interpretaciones.metricas.length >= 4 && res.interpretaciones.graficas.length >= 3 && res.interpretaciones.metricas.every(function (t) { return t.id && t.texto.length > 20; }), 'interpretaciones');
    sinNoFinitos(res);
    ok(JSON.stringify(res).indexOf('NaN') < 0 && JSON.stringify(res).indexOf('Infinity') < 0, 'sin NaN/Infinity serializados');
  }
  const regMetodos = ['ols', 'ridge', 'lasso', 'arbol_reg', 'bosque_reg', 'knn_reg'];
  for (const id of regMetodos) {
    await prueba('supervisado · ' + id + ' (regresión) de punta a punta', async function () {
      const evs = [];
      const res = await MLMotor.correr({ enfoque: 'sup', y: 'y', x: xReg, metodo: id, semilla: 42, prop_prueba: 0.2, folds: 4 }, dsReg, function (e) { evs.push(e); });
      chkSup(res, 'regresion', id);
      const m = res.metricas.prueba;
      ['r2', 'r2_ajustado', 'rmse', 'mae', 'sesgo', 'ratio_rmse_sd'].forEach(function (k) { ok(typeof m[k] === 'number', 'métrica ' + k); });
      ok(m.r2 > (id === 'knn_reg' ? 0.6 : (id.indexOf('arbol') === 0 ? 0.6 : 0.85)), 'R² de prueba razonable: ' + m.r2);
      ok(res.residuos && res.residuos.valor.length === res.prep.nTest && res.residuos.normalidad.p >= 0 && res.residuos.heterocedasticidad.breuschPaganLike && typeof res.residuos.durbinWatson === 'number', 'residuos');
      if (id === 'ols') ok(res.coeficientes.length === res.prep.columnasFinales.length + 1 && res.coeficientes[1].p !== null, 'coeficientes con p');
      if (id === 'ridge' || id === 'lasso') ok(res.hiperparametros.rejilla.length === 6 && res.hiperparametros.elegidos.lambda > 0, 'rejilla de λ');
      if (id === 'arbol_reg') ok(res.hiperparametros.elegidos.profundidad && res.hiperparametros.elegidos.hoja_min, 'profundidad y hoja');
      if (id === 'bosque_reg') ok(res.hiperparametros.elegidos.arboles <= 100 && res.hiperparametros.elegidos.mtry >= 1, 'árboles y mtry');
      if (id === 'knn_reg') ok(res.hiperparametros.elegidos.k >= 1, 'k');
      if (id === 'ols') ok(/no tiene hiperpar/.test(res.etapas[2].detalle), 'calibración omitida con detalle claro');
      const idsEv = evs.map(function (e) { return e.id; });
      ETAPAS_SUP.forEach(function (e) { ok(evs.some(function (x) { return x.id === e && x.progreso === 0; }) && evs.some(function (x) { return x.id === e && x.progreso === 1; }), 'onEtapa inicio/fin de ' + e); });
      ok(evs.every(function (e) { return e.progreso >= 0 && e.progreso <= 1 && e.nombre; }), 'progreso entre 0 y 1');
    });
  }
  const clfMetodos = ['logistica', 'arbol_clf', 'bosque_clf', 'knn_clf', 'naive_bayes', 'lda'];
  for (const id of clfMetodos) {
    await prueba('supervisado · ' + id + ' (binaria) de punta a punta', async function () {
      const res = await MLMotor.correr({ enfoque: 'sup', y: 'y', x: ['x1', 'x2', 'x3', 'x4', 'x5'], metodo: id, semilla: 42, folds: 4 }, dsBin);
      chkSup(res, 'binaria', id);
      const m = res.metricas.prueba;
      ['exactitud', 'exactitud_balanceada', 'precision_macro', 'recall_macro', 'f1_macro', 'auc', 'log_loss', 'kappa', 'precision', 'recall', 'f1'].forEach(function (k) { ok(typeof m[k] === 'number', 'métrica ' + k); });
      ok(m.porClase.si && m.porClase.no && typeof m.porClase.si.f1 === 'number', 'métricas por clase');
      ok(m.exactitud > (id === 'arbol_clf' ? 0.78 : 0.88) && m.auc > (id === 'arbol_clf' ? 0.85 : 0.93), 'clasificación separable: exactitud ' + m.exactitud + ' auc ' + m.auc);
      ok(res.matrizConfusion.clases.length === 2 && res.matrizConfusion.m.length === 2, 'matriz de confusión');
      ok(res.roc.fpr.length === res.roc.tpr.length && res.roc.fpr[0] === 0 && res.roc.tpr[res.roc.tpr.length - 1] === 1 && Math.abs(res.roc.auc - m.auc) < 1e-12, 'ROC');
      ok(res.calibracion.bins.length >= 2 && res.calibracion.bins.every(function (b) { return b.n > 0 && b.p_media >= 0 && b.frec_obs <= 1; }), 'calibración');
      ok(Array.isArray(res.predicciones.prob) && res.predicciones.prob[0].length === 2 && Math.abs(res.predicciones.prob[0][0] + res.predicciones.prob[0][1] - 1) < 1e-9, 'probabilidades');
      ok(res.importancias[0].var === 'Variable 1' || res.importancias[0].var === 'Variable 2', 'variables informativas primero: ' + res.importancias[0].var);
      if (id === 'logistica') { ok(res.coeficientes.length === 6 && typeof res.coeficientes[1].oddsRatio === 'number' && res.coeficientes[1].p !== null, 'coeficientes con odds ratio'); ok(/no tiene hiperpar/.test(res.etapas[2].detalle), 'sin hiperparámetros'); }
      if (id === 'bosque_clf') ok(res.hiperparametros.rejilla.length >= 2, 'rejilla de bosque');
    });
  }
  for (const id of clfMetodos) {
    await prueba('supervisado · ' + id + ' (multiclase, 3 clases) de punta a punta', async function () {
      const res = await MLMotor.correr({ enfoque: 'sup', y: 'y', x: ['x1', 'x2', 'x3', 'x4'], metodo: id, semilla: 3, folds: 3 }, dsMul);
      chkSup(res, 'multiclase', id);
      ok(res.metricas.prueba.exactitud > 0.85, 'exactitud multiclase: ' + res.metricas.prueba.exactitud);
      ok(res.matrizConfusion.clases.length === 3 && res.roc.auc > 0.9 && res.metricas.prueba.auc > 0.9, 'AUC macro uno contra resto');
      ok(res.predicciones.prob[0].length === 3, 'probabilidades por clase');
      if (id === 'logistica') ok(res.coeficientes.length === 2 * 5 && res.coeficientes[0].clase, 'coeficientes multinomiales por clase');
    });
  }

  // ======================= 7. No supervisados =======================
  const cl = datasetClusters(120, 71);
  await prueba('k-medias recupera 3 grupos conocidos (k automático)', async function () {
    const res = await MLMotor.correr({ enfoque: 'nosup', metodo: 'kmeans', semilla: 42 }, cl.ds);
    ok(res.clusters.k === 3, 'k = ' + res.clusters.k);
    const a = res.clusters.asignacion, tabla = {};
    a.forEach(function (c, i) { const k = cl.real[i] + '-' + c; tabla[k] = (tabla[k] || 0) + 1; });
    for (let t = 0; t < 3; t++) { let mx = 0, tot = 0; for (let c = 0; c < 3; c++) { const v = tabla[t + '-' + c] || 0; tot += v; mx = Math.max(mx, v); } ok(mx / tot >= 0.97, 'grupo real ' + t + ' bien recuperado: ' + (mx / tot)); }
    ok(res.clusters.silueta > 0.6 && res.clusters.indiceCH > 100 && res.clusters.indiceDB < 0.6, 'índices de calidad');
    ok(res.clusters.elbow.length >= 5 && res.clusters.elbow[0].k === 2 && typeof res.clusters.elbow[0].inercia === 'number', 'codo');
    ok(res.clusters.etiquetaSugerida.length === 3 && /Alto en|Bajo en/.test(res.clusters.etiquetaSugerida[0]), 'etiquetas: ' + res.clusters.etiquetaSugerida[0]);
    ok(res.clusters.centroides.length === 3 && res.clusters.centroides[0].length === 4 && res.clusters.tamanos.reduce(function (s, x) { return s + x; }, 0) === 360, 'centroides y tamaños');
    ok(res.clusters.perfil[0].variablesDistintivas.length >= 1 && typeof res.clusters.perfil[0].variablesDistintivas[0].z === 'number', 'perfil');
    ok(ids(res).join() === ETAPAS_NOSUP.join(), 'etapas ' + ids(res).join());
    // centroides en unidades originales: los verdaderos son 0, 8, 8,8..
    const cs = res.clusters.centroides.map(function (c) { return String(Math.round(c[0])) + ',' + String(Math.round(c[1])); }).sort().join('|');
    ok(cs === '0,0|0,8|8,8', 'centroides en unidades originales: ' + cs);
    sinNoFinitos(res);
  });
  await prueba('k-medias con k fijo por el usuario', async function () {
    const res = await MLMotor.correr({ enfoque: 'nosup', metodo: 'kmeans', k: 4 }, cl.ds);
    ok(res.clusters.k === 4, 'k fijo');
  });
  await prueba('PCA: varianza, cargas, scores y componentes al 80 %', async function () {
    const r = rngSeed(81), rows = [];
    for (let i = 0; i < 300; i++) { const f = r.normal(); rows.push([f + 0.1 * r.normal(), 2 * f + 0.1 * r.normal(), -f + 0.1 * r.normal(), r.normal()]); }
    const res = await MLMotor.correr({ enfoque: 'nosup', metodo: 'pca', x: ['a', 'b', 'c', 'd'], prep: { global: { colineales: 'ninguno', transformacion: 'ninguna', outliers: 'ninguno', escalado: 'estandar', faltantes: 'media', duplicados: 'ninguno', constantes: 'eliminar', codificacion: 'onehot', columnaFaltantes: 'conservar' } } }, { cols: [{ name: 'a' }, { name: 'b' }, { name: 'c' }, { name: 'd' }], rows: rows });
    const p = res.pca;
    cerca(p.varianza.reduce(function (s, x) { return s + x; }, 0), 1, 1e-9, 'suma de varianza'); cerca(p.acumulada[3], 1, 1e-9, 'acumulada');
    ok(p.varianza[0] > 0.7 && p.nComponentes80 === 2, 'primer componente domina; 80 % con 2: ' + p.nComponentes80);
    ok(p.cargas.length === 4 && p.cargas[0].pc.length === 4 && p.scores.length === 300 && p.scores[0].length === 3, 'cargas y scores');
    ok(Math.abs(p.cargas[0].pc[0]) > 0.9 && Math.abs(p.cargas[3].pc[0]) < 0.3, 'carga del PC1 en variables correlacionadas');
    ok(ids(res).join() === ETAPAS_NOSUP.join(), 'etapas');
  });
  await prueba('jerárquico (Ward) recupera 3 grupos', async function () {
    const res = await MLMotor.correr({ enfoque: 'nosup', metodo: 'jerarquico', semilla: 1 }, cl.ds);
    ok(res.clusters.k === 3, 'k = ' + res.clusters.k);
    const tabla = {}; res.clusters.asignacion.forEach(function (c, i) { const k = cl.real[i] + '-' + c; tabla[k] = (tabla[k] || 0) + 1; });
    for (let t = 0; t < 3; t++) { let mx = 0, tot = 0; for (let c = 0; c < 3; c++) { const v = tabla[t + '-' + c] || 0; tot += v; mx = Math.max(mx, v); } ok(mx / tot >= 0.97, 'grupo ' + t); }
  });
  await prueba('jerárquico con n > 1500 usa muestra y asigna el resto', async function () {
    const big = datasetClusters(600, 72);
    const res = await MLMotor.correr({ enfoque: 'nosup', metodo: 'jerarquico', semilla: 1 }, big.ds);
    ok(res.clusters.muestra === 1500 && res.clusters.k === 3, 'muestra 1500, k=' + res.clusters.k);
    ok(res.clusters.asignacion.every(function (c) { return c >= 0; }) && res.clusters.asignacion.length === 1800, 'todas las filas asignadas');
  });
  await prueba('DBSCAN encuentra grupos y marca ruido', async function () {
    const r = rngSeed(91), rows = [];
    for (let c = 0; c < 2; c++) for (let i = 0; i < 150; i++) rows.push([c * 10 + r.normal() * 0.7, r.normal() * 0.7]);
    for (let i = 0; i < 10; i++) rows.push([r() * 60 - 25, r() * 60 - 30 + 40]);
    const res = await MLMotor.correr({ enfoque: 'nosup', metodo: 'dbscan', semilla: 1, prep: { global: { colineales: 'ninguno', transformacion: 'ninguna', outliers: 'ninguno', escalado: 'estandar', faltantes: 'media', duplicados: 'ninguno', constantes: 'eliminar', codificacion: 'onehot', columnaFaltantes: 'conservar' } } }, { cols: [{ name: 'a' }, { name: 'b' }], rows: rows });
    ok(res.clusters.k >= 2 && res.clusters.k <= 4, 'grupos encontrados: ' + res.clusters.k);
    ok(res.clusters.eps > 0 && res.clusters.asignacion.slice(300).filter(function (c) { return c === -1; }).length >= 5, 'los puntos dispersos quedan como ruido (-1)');
    ok(res.clusters.tamanos[0] >= 130 && res.clusters.tamanos[1] >= 130, 'los dos grupos grandes');
  });
  await prueba('correlaciones: Pearson, Spearman y pares fuertes', async function () {
    const r = rngSeed(101), rows = [];
    for (let i = 0; i < 300; i++) { const a = r.normal(); rows.push([a, a * a * a + 0.05 * r.normal(), r.normal(), 0.9 * a + 0.3 * r.normal(), 'k' + (i % 3)]); }
    const res = await MLMotor.correr({ enfoque: 'nosup', metodo: 'correlaciones', x: ['a', 'b', 'c', 'd', 'cat'], prep: { global: { colineales: 'ninguno', transformacion: 'ninguna', outliers: 'ninguno', escalado: 'ninguno', faltantes: 'media', duplicados: 'ninguno', constantes: 'eliminar', codificacion: 'onehot', columnaFaltantes: 'conservar' } } }, { cols: [{ name: 'a' }, { name: 'b' }, { name: 'c' }, { name: 'd' }, { name: 'cat' }], rows: rows });
    const c = res.correlaciones;
    ok(c.vars.length === 4 && c.pearson.length === 4 && c.spearman[0][0] === 1, 'matrices (solo numéricas)');
    const par = c.paresFuertes.filter(function (q) { return q.a === 'a' && q.b === 'd'; })[0];
    ok(par && par.r > 0.9, 'a-d fuerte'); const pb = c.paresFuertes.filter(function (q) { return q.a === 'a' && q.b === 'b'; })[0];
    ok(pb && pb.rho > 0.95 && pb.r < pb.rho, 'relación monótona no lineal: Spearman > Pearson');
    ok(Math.abs(c.pearson[0][3] - c.pearson[3][0]) < 1e-12, 'simétrica');
  });
  await prueba('anomalías: Mahalanobis robusta detecta casos sembrados', async function () {
    const r = rngSeed(111), rows = [];
    for (let i = 0; i < 400; i++) { const a = r.normal(), b = 0.8 * a + 0.4 * r.normal(); rows.push([a, b, r.normal()]); }
    // anómalos: combinaciones raras (cada valor es normal pero la relación se rompe) y extremos
    [[2, -2.5, 0], [-2.2, 2.4, 0], [8, 8, 8], [-9, 0, 9], [0, 7, -7]].forEach(function (f) { rows.push(f); });
    const res = await MLMotor.correr({ enfoque: 'nosup', metodo: 'anomalias', prep: { global: { colineales: 'ninguno', transformacion: 'ninguna', outliers: 'ninguno', escalado: 'estandar', faltantes: 'media', duplicados: 'ninguno', constantes: 'eliminar', codificacion: 'onehot', columnaFaltantes: 'conservar' } } }, { cols: [{ name: 'a' }, { name: 'b' }, { name: 'c' }], rows: rows });
    const an = res.anomalias; let hit = 0; for (let i = 400; i < 405; i++) if (an.idx.indexOf(i) >= 0) hit++;
    ok(hit >= 4, 'anómalos sembrados detectados: ' + hit + ' de 5'); ok(an.idx.length <= 40, 'pocos falsos positivos: ' + an.idx.length);
    ok(an.puntaje.length === 405 && an.umbral > 0 && an.variablesQueMasAportan.length > 0 && Array.isArray(an.variablesQueMasAportan[0].vars), 'puntaje y variables');
    ok(an.puntaje[402] > an.puntaje[0], 'el extremo puntúa más');
  });
  for (const id of ['pca', 'kmeans', 'jerarquico', 'dbscan', 'correlaciones', 'anomalias']) {
    await prueba('no supervisado · ' + id + ': etapas, KPIs, hallazgos e interpretaciones', async function () {
      const evs = [];
      const res = await MLMotor.correr({ enfoque: 'nosup', metodo: id, semilla: 5 }, cl.ds, function (e) { evs.push(e.id); });
      ok(ids(res).join() === ETAPAS_NOSUP.join() && evs.length >= 10, 'etapas y eventos');
      ok(res.kpis.length >= 2 && res.hallazgos.length >= 1 && res.interpretaciones.metricas.length + res.interpretaciones.graficas.length >= 2, 'textos');
      ok(res.prep.pasos.length > 0 && res.prep.nTrain === 360, 'prep');
      sinNoFinitos(res);
    });
  }

  // ======================= 8. Datos sucios y robustez =======================
  await prueba('faltantes + atípicos: se aplican y se reportan (sin NaN)', async function () {
    const r = rngSeed(121), rows = [];
    for (let i = 0; i < 400; i++) {
      const a = r.normal(), b = Math.exp(r.normal()), c = r() < 0.5 ? 'x' : 'y';
      let y = 2 * a + Math.log(b) + (c === 'x' ? 1 : 0) + 0.3 * r.normal();
      let av = i % 8 === 0 ? null : a; let bv = i % 13 === 0 ? '' : (i === 7 ? b * 500 : b);
      rows.push([av, bv === '' ? ' ' : String(typeof bv === 'number' ? bv.toFixed(3) : bv), i % 11 === 0 ? null : c, i % 5 === 0 ? null : 1, y]);
    }
    for (const modo of ['media', 'mediana', 'moda', 'knn', 'constante_cero', 'indicador_y_mediana', 'eliminar_filas']) {
      const res = await MLMotor.correr({ enfoque: 'sup', y: 'y', x: ['a', 'b', 'c', 'const'], metodo: 'ols', semilla: 1, folds: 3, prep: { global: { faltantes: modo, outliers: 'iqr_recortar', transformacion: 'log1p_si_sesgo', escalado: 'robusto', codificacion: 'onehot', duplicados: 'eliminar', colineales: 'eliminar_r95', constantes: 'eliminar', columnaFaltantes: 'conservar' } } }, { cols: [{ name: 'a' }, { name: 'b' }, { name: 'c' }, { name: 'const' }, { name: 'y' }], rows: rows });
      sinNoFinitos(res);
      ok(res.prep.descartadas.some(function (d) { return d.name === 'const'; }), 'constante descartada (' + modo + ')');
      ok(res.prep.pasos.some(function (p) { return /extremos/.test(p); }) && res.prep.pasos.some(function (p) { return /Transformación/.test(p); }), 'pasos de extremos y transformación (' + modo + ')');
      if (modo !== 'eliminar_filas') ok(res.prep.pasos.some(function (p) { return /rellenaron \d+ celdas/.test(p); }), 'conteo de celdas rellenadas (' + modo + ')');
      else ok(res.prep.pasos.some(function (p) { return /se quitaron \d+ filas/.test(p); }), 'filas quitadas');
      if (modo === 'indicador_y_mediana') ok(res.prep.columnasFinales.some(function (n) { return /__faltante/.test(n); }), 'columna indicadora');
      ok(res.metricas.prueba.r2 > (modo === 'moda' ? 0.4 : 0.7), 'ajuste razonable con datos sucios (' + modo + '): ' + res.metricas.prueba.r2);
    }
  });
  await prueba('columna con >60 % faltantes se descarta; columnas todo-NaN no rompen', async function () {
    const r = rngSeed(131), rows = [];
    for (let i = 0; i < 200; i++) rows.push([r.normal(), i < 150 ? null : r.normal(), null, r.normal()]);
    rows.forEach(function (f) { f.push(2 * f[0] + 0.1 * r.normal()); });
    const res = await MLMotor.correr({ enfoque: 'sup', y: 'y', x: ['a', 'b', 'todo', 'c'], metodo: 'ridge', semilla: 1, folds: 3 }, { cols: [{ name: 'a' }, { name: 'b' }, { name: 'todo' }, { name: 'c' }, { name: 'y' }], rows: rows });
    const d = res.prep.descartadas.map(function (x) { return x.name; });
    ok(d.indexOf('b') >= 0 && d.indexOf('todo') >= 0, 'descartadas: ' + d.join());
    ok(res.prep.columnasFinales.indexOf('a') >= 0, 'se conserva a');
  });
  await prueba('errores claros en español: constantes, una clase, n chico, método inválido', async function () {
    const falla = async function (cfg, ds, rx, etiqueta) { let msg = null; try { await MLMotor.correr(cfg, ds); } catch (e) { msg = e.message; } ok(msg !== null && rx.test(msg) && /[áéíóúñ]|[a-z]{4}/.test(msg), etiqueta + ': ' + msg); };
    const base = datasetReg(100, 3, 141, false);
    await falla({ enfoque: 'sup', y: 'y', x: ['k'], metodo: 'ols' }, { cols: [{ name: 'k' }, { name: 'y' }], rows: base.rows.map(function (f) { return [5, f[f.length - 1]]; }) }, /ninguna variable utilizable/, 'x constante');
    await falla({ enfoque: 'sup', y: 'y', x: ['x1'], metodo: 'logistica' }, { cols: [{ name: 'x1' }, { name: 'y' }], rows: base.rows.map(function (f) { return [f[0], 'igual']; }) }, /solo valor/, 'una sola clase');
    await falla({ enfoque: 'sup', y: 'y', x: ['x1', 'x2'], metodo: 'ols' }, { cols: base.cols, rows: base.rows.slice(0, 8) }, /al menos 20 filas/, 'n muy chico');
    await falla({ enfoque: 'sup', y: 'y', x: ['x1'], metodo: 'inventado' }, base, /no existe/, 'método inventado');
    await falla({ enfoque: 'sup', y: 'zzz', x: ['x1'], metodo: 'ols' }, base, /no se encontr/, 'y inexistente');
    await falla({ enfoque: 'sup', y: 'y', x: ['x1'], metodo: 'logistica' }, base, /número continuo/, 'clasificar con y continua');
    await falla({ enfoque: 'sup', y: 'y', x: ['x1'], metodo: 'ols' }, { cols: [{ name: 'x1' }, { name: 'y' }], rows: base.rows.map(function (f, i) { return [f[0], i % 2 ? 'a' : 'b']; }) }, /categor/, 'regresión con y categórica');
    await falla({ enfoque: 'nosup', metodo: 'kmeans' }, { cols: [{ name: 'a' }, { name: 'b' }], rows: [[1, 2], [2, 3], [3, 4]] }, /al menos 30 filas/, 'kmeans con 3 filas');
    await falla({ enfoque: 'xx', metodo: 'ols' }, base, /enfoque/, 'enfoque inválido');
  });
  await prueba('y con 1 sola observación de una clase se avisa/ignora sin colgarse; n pequeño (30 filas) corre', async function () {
    const r = rngSeed(151), rows = [];
    for (let i = 0; i < 40; i++) rows.push([r.normal(), r.normal(), i < 19 ? 'a' : (i < 38 ? 'b' : 'rara')]);
    const res = await MLMotor.correr({ enfoque: 'sup', y: 'y', x: ['a', 'b'], metodo: 'arbol_clf', semilla: 1, folds: 3 }, { cols: [{ name: 'a' }, { name: 'b' }, { name: 'y' }], rows: rows });
    ok(res.prep.pasos.some(function (p) { return /menos de 3 casos/.test(p); }) && res.advertencias.length > 0, 'aviso por clase rara y n pequeño');
    sinNoFinitos(res);
    const res2 = await MLMotor.correr({ enfoque: 'sup', y: 'y', x: ['x1', 'x2', 'x3'], metodo: 'arbol_reg', semilla: 1 }, datasetReg(35, 3, 152, false));
    ok(res2.prep.nTrain > 20 && res2.advertencias.some(function (a) { return /pocas filas/.test(a); }), 'advertencia por n pequeño');
  });
  await prueba('cat con muchas categorías usa frecuencia; texto libre se descarta', async function () {
    const r = rngSeed(161), rows = [];
    for (let i = 0; i < 400; i++) { const k = Math.floor(r() * 25); rows.push([r.normal(), 'cat' + k, 'nombre libre ' + i, 3 * (k % 5) + r.normal()]); }
    const cfgBase = { enfoque: 'sup', y: 'y', x: ['a', 'cat', 'txt'], metodo: 'ridge', semilla: 1, folds: 3 };
    const ds = { cols: [{ name: 'a' }, { name: 'cat' }, { name: 'txt' }, { name: 'y' }], rows: rows };
    const res = await MLMotor.correr(cfgBase, ds);
    ok(res.prep.descartadas.some(function (d) { return d.name === 'txt'; }), 'texto libre descartado');
    ok(res.prep.columnasFinales.indexOf('cat') >= 0 && res.prep.columnasFinales.length === 2, 'frecuencia: una sola columna para cat: ' + res.prep.columnasFinales.join());
    const sug = MLMotor.sugerirPrep(MLMotor.perfilar(ds), { enfoque: 'sup', y: 'y', x: ['a', 'cat'], n: 400 });
    ok(sug.global.codificacion.id === 'frecuencia', 'sugerencia: frecuencia');
  });
  await prueba('no bloquea el navegador: cede el control durante el cómputo', async function () {
    let ticks = 0; const iv = setInterval(function () { ticks++; }, 5);
    await MLMotor.correr({ enfoque: 'sup', y: 'y', x: xReg, metodo: 'bosque_reg', semilla: 1, folds: 3 }, datasetReg(1200, 6, 171, true));
    clearInterval(iv);
    ok(ticks >= 5, 'el temporizador siguió corriendo durante el análisis (ticks=' + ticks + ')');
  });

  // ======================= 9. Tiempos con 3 000 filas × 20 variables =======================
  console.log('\nTiempos (3 000 filas × 20 variables: 17 numéricas + 2 categóricas + resultado):');
  const gr = rngSeed(181), colsT = [], rowsT = [];
  for (let j = 0; j < 17; j++) colsT.push({ name: 'v' + j }); colsT.push({ name: 'c1' }, { name: 'c2' }, { name: 'yr' }, { name: 'yb' });
  for (let i = 0; i < 3000; i++) {
    const x = []; for (let j = 0; j < 17; j++) x.push(j % 4 === 0 ? Math.exp(gr.normal() * 0.7) : gr.normal());
    if (i % 20 === 0) x[3] = null;
    const c1 = ['a', 'b', 'c'][Math.floor(gr() * 3)], c2 = ['p', 'q', 'r', 's'][Math.floor(gr() * 4)];
    const lin = 1.5 * x[1] - 2 * x[2] + 0.8 * x[5] + Math.sin(x[6] * 2) + (c1 === 'b' ? 1 : 0);
    rowsT.push(x.concat([c1, c2, lin + 0.5 * gr.normal(), lin + gr.normal() > 0 ? 'si' : 'no']));
  }
  const dsT = { cols: colsT, rows: rowsT }, xT = colsT.slice(0, 19).map(function (c) { return c.name; });
  const tiempos = {};
  for (const id of regMetodos.concat(clfMetodos)) {
    const esR = regMetodos.indexOf(id) >= 0;
    await prueba('tiempo · ' + id + ' en 3 000 × 20', async function () {
      const t0 = Date.now();
      const res = await MLMotor.correr({ enfoque: 'sup', y: esR ? 'yr' : 'yb', x: xT, metodo: id, semilla: 1 }, dsT);
      tiempos[id] = Date.now() - t0; sinNoFinitos(res);
      ok(tiempos[id] < 60000, 'demasiado lento: ' + tiempos[id] + ' ms');
      if (esR) ok(res.metricas.prueba.r2 > 0.4, 'R² ' + res.metricas.prueba.r2); else ok(res.metricas.prueba.exactitud > 0.7, 'exactitud ' + res.metricas.prueba.exactitud);
    });
  }
  for (const id of ['pca', 'kmeans', 'jerarquico', 'dbscan', 'correlaciones', 'anomalias']) {
    await prueba('tiempo · ' + id + ' en 3 000 × 20', async function () {
      const t0 = Date.now();
      const res = await MLMotor.correr({ enfoque: 'nosup', metodo: id, x: xT.slice(0, 17), semilla: 1 }, dsT);
      tiempos[id] = Date.now() - t0; sinNoFinitos(res);
      ok(tiempos[id] < 60000, 'demasiado lento: ' + tiempos[id] + ' ms');
    });
  }
  console.log('\nResumen de tiempos (ms): ' + Object.keys(tiempos).map(function (k) { return k + '=' + tiempos[k]; }).join('  '));

  // ======================= Resultado =======================
  console.log('\n' + (total - fallos) + ' de ' + total + ' pruebas pasaron' + (fallos ? ' — ' + fallos + ' FALLARON' : '.'));
  process.exit(fallos ? 1 : 0);
})();
