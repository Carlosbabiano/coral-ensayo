// Pruebas de partir, fundir, insertar y quitar compases (app/compases.js). Sin dependencias:
//   node herramientas/pruebas/compases-estructura.test.js
// Si existe el borrador de prueba «1. Nosotros hemos de gloriarnos» (borradores/b261101115701jr1), también se prueba con él.
const assert = require('assert');
const fs = require('fs'), path = require('path');
const C = require('../../app/compases.js');

const nota = (step, oct, type, dur, extra = '') => `<note><pitch><step>${step}</step><alter>0</alter><octave>${oct}</octave></pitch><duration>${dur}</duration><voice>1</voice><type>${type}</type><staff>1</staff>${extra}</note>`;
const letra = t => `<lyric number="1"><syllabic>single</syllabic><text>${t}</text></lyric>`;
const compas = (n, cuerpo) => `\n\t\t<measure number="${n}">\n\t\t\t${cuerpo}\n\t\t</measure>`;
const parte = (id, compases) => `\n\t<part id="${id}">${compases.join('')}\n\t</part>`;
const ATTR1 = '<attributes><divisions>2</divisions><key><fifths>-1</fifths></key><time><beats>2</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes>';
const obra = partes => `<?xml version="1.0"?>\n<score-partwise version="3.0">\n\t<part-list>${partes.map(p => `<score-part id="${p.id}"><part-name>${p.nombre}</part-name></score-part>`).join('')}</part-list>${partes.map(p => parte(p.id, p.compases)).join('')}\n</score-partwise>`;

// Resumen por compás: { num: { P1: { 1: negras, 2: negras }, P2: ... } }
function sumas(xml) {
  const r = {};
  C.recorrerCompases(xml, c => { (r[c.num] = r[c.num] || {})[c.id] = C.sumasPorVoz(c.cuerpo, c.div); });
  return r;
}
const numeros = xml => [...xml.matchAll(/<part id="([^"]+)">([\s\S]*?)<\/part>/g)].map(([, id, p]) => [id, [...p.matchAll(/<measure number="([^"]+)"/g)].map(m => m[1])]);
const cuerpoDe = (xml, partId, num) => { let r = null; C.recorrerCompases(xml, c => { if (c.id === partId && c.num === String(num)) r = c.cuerpo; }); return r; };
let pruebas = 0;
function prueba(nombre, f) { try { f(); pruebas++; console.log('  ok  ' + nombre); } catch (e) { console.log('  FALLA ' + nombre + '\n' + (e.stack || e.message)); process.exitCode = 1; } }

// Obra pequeña: 2 voces, 2/4, divisiones 2. El compás 2 de la Soprano tiene 4 negras (dos compases de la página en uno).
const P1 = [
  compas(1, ATTR1 + nota('C', 4, 'quarter', 2, letra('Glo')) + nota('D', 4, 'quarter', 2, letra('ria'))),
  compas(2, '<attributes><divisions>2</divisions></attributes>' + nota('F', 4, 'quarter', 2, letra('No')) + nota('D', 4, 'eighth', 1, '<beam number="1">begin</beam>' + letra('so')) + nota('E', 4, 'eighth', 1, '<beam number="1">end</beam>' + letra('tros')) + nota('G', 4, 'quarter', 2, letra('he')) + nota('A', 4, 'quarter', 2, letra('mos')) + '<barline location="right"><bar-style>light-light</bar-style></barline>'),
  compas(3, nota('C', 5, 'half', 4, letra('de'))),
];
const P2 = [
  compas(1, ATTR1.replace('<sign>G</sign><line>2</line>', '<sign>F</sign><line>4</line>') + nota('C', 3, 'half', 4)),
  compas(2, '<attributes><divisions>2</divisions></attributes>' + nota('C', 3, 'quarter', 2) + nota('D', 3, 'half', 4, letra('oh')) + nota('E', 3, 'quarter', 2) + '<barline location="right"><bar-style>light-light</bar-style></barline>'),
  compas(3, '<note><rest measure="yes"/><duration>4</duration><voice>1</voice><type>whole</type><staff>1</staff></note>'),
];
const XML = obra([{ id: 'P1', nombre: 'Soprano', compases: P1 }, { id: 'P2', nombre: 'Bajo', compases: P2 }]);

console.log('Obra pequeña');
prueba('el compás 2 está entre los sospechosos antes de partir', () => assert.deepStrictEqual(C.sospechososDe(XML), ['2']));

let partido;
prueba('partir el compás 2 en la negra 2: 4 compases en las dos voces, todos cuadran', () => {
  partido = C.partirCompas(XML, 2, 2);
  assert.deepStrictEqual(numeros(partido), [['P1', ['1', '2', '3', '4']], ['P2', ['1', '2', '3', '4']]]);
  assert.deepStrictEqual(C.sospechososDe(partido), []);
  const s = sumas(partido);
  assert.deepStrictEqual(s['2'], { P1: { 1: 2 }, P2: { 1: 2 } });
  assert.deepStrictEqual(s['3'], { P1: { 1: 2 }, P2: { 1: 2 } });
});
prueba('la nota que cruza el corte queda en dos ligadas y la letra en la primera', () => {
  const c2 = cuerpoDe(partido, 'P2', 2), c3 = cuerpoDe(partido, 'P2', 3);
  assert.match(c2, /<step>D<\/step>[\s\S]*?<duration>2<\/duration><tie type="start"\/>[\s\S]*?<type>quarter<\/type>[\s\S]*?<tied type="start"\/>[\s\S]*?<text>oh<\/text>/);
  assert.match(c3, /<step>D<\/step>[\s\S]*?<duration>2<\/duration><tie type="stop"\/>[\s\S]*?<type>quarter<\/type>[\s\S]*?<tied type="stop"\/>/);
  assert.ok(!/<text>oh<\/text>/.test(c3), 'la segunda mitad no repite la letra');
});
prueba('la barra doble pasa a la segunda mitad, los atributos se quedan en la primera y las letras siguen', () => {
  const c2 = cuerpoDe(partido, 'P1', 2), c3 = cuerpoDe(partido, 'P1', 3);
  assert.ok(/<attributes>/.test(c2) && !/<attributes>/.test(c3));
  assert.ok(!/<barline/.test(c2) && /light-light/.test(c3));
  assert.deepStrictEqual([...c2.matchAll(/<text>([^<]*)/g)].map(m => m[1]), ['No', 'so', 'tros']);
  assert.deepStrictEqual([...c3.matchAll(/<text>([^<]*)/g)].map(m => m[1]), ['he', 'mos']);
  assert.ok(/<beam number="1">begin<\/beam>[\s\S]*<beam number="1">end<\/beam>/.test(c2), 'el corchete de las corcheas se conserva');
});
prueba('el compás 4 (antes 3) sigue teniendo las divisiones correctas', () => assert.deepStrictEqual(sumas(partido)['4'], { P1: { 1: 2 }, P2: { 1: 2 } }));
prueba('partir en una posición que no es entera en divisiones (0.75) multiplica las divisiones y el siguiente las declara', () => {
  const x = C.partirCompas(XML, 1, 0.75);
  assert.deepStrictEqual(numeros(x)[0][1], ['1', '2', '3', '4']);
  assert.match(cuerpoDe(x, 'P1', 1), /<divisions>4<\/divisions>/);
  assert.match(cuerpoDe(x, 'P1', 3), /<divisions>2<\/divisions>/);
  const s = sumas(x); assert.deepStrictEqual(s['1'], { P1: { 1: 0.75 }, P2: { 1: 0.75 } }); assert.deepStrictEqual(s['2'], { P1: { 1: 1.25 }, P2: { 1: 1.25 } });
  assert.match(cuerpoDe(x, 'P1', 1), /<type>eighth<\/type><dot\/>/, 'la primera mitad: una corchea con puntillo');
  assert.match(cuerpoDe(x, 'P1', 2), /<type>16th<\/type>[\s\S]*<type>quarter<\/type>/, 'la segunda: la semicorchea ligada y la negra');
});
prueba('partir fuera del compás o en un compás que no existe da error claro', () => {
  assert.throws(() => C.partirCompas(XML, 2, 4), /corte tiene que caer dentro/);
  assert.throws(() => C.partirCompas(XML, 9, 1), /No existe el compás 9/);
});

prueba('fundir los dos compases partidos devuelve 3 compases y el 2 vuelve a sumar 4', () => {
  const x = C.fundirCompases(partido, 2);
  assert.deepStrictEqual(numeros(x), [['P1', ['1', '2', '3']], ['P2', ['1', '2', '3']]]);
  assert.deepStrictEqual(sumas(x)['2'], { P1: { 1: 4 }, P2: { 1: 4 } });
  assert.deepStrictEqual(C.sospechososDe(x), ['2']);
  assert.match(cuerpoDe(x, 'P1', 2), /light-light/);
  assert.deepStrictEqual([...cuerpoDe(x, 'P1', 2).matchAll(/<text>([^<]*)/g)].map(m => m[1]), ['No', 'so', 'tros', 'he', 'mos']);
  assert.strictEqual((cuerpoDe(x, 'P1', 2).match(/<attributes>/g) || []).length, 1);
});
prueba('fundir dos silencios de compás entero deja uno que llena el compás', () => {
  const x = C.fundirCompases(C.partirCompas(XML, 3, 1), 3);
  const c = cuerpoDe(x, 'P2', 3);
  assert.strictEqual((c.match(/<note>/g) || []).length, 1);
  assert.match(c, /<rest measure="yes"\/><duration>4<\/duration>/);
  assert.deepStrictEqual(sumas(x)['3'], { P1: { 1: 2 }, P2: { 1: 2 } });
});
prueba('fundir con divisiones distintas las iguala', () => {
  const x = C.fundirCompases(XML, 1); // el 1 tiene divisiones 2 y el 2 también, pero el siguiente (3) heredaba del 2
  assert.deepStrictEqual(sumas(x)['1'], { P1: { 1: 6 }, P2: { 1: 6 } });
  assert.deepStrictEqual(sumas(x)['2'], { P1: { 1: 2 }, P2: { 1: 2 } });
  assert.throws(() => C.fundirCompases(XML, 3), /es el último/);
});

prueba('insertar un compás después del 1: compás de silencio en las dos voces, nada nuevo sospechoso', () => {
  const x = C.insertarCompas(XML, 1, false);
  assert.deepStrictEqual(numeros(x)[0][1], ['1', '2', '3', '4']);
  assert.match(cuerpoDe(x, 'P1', 2), /<rest measure="yes"\/><duration>4<\/duration>/);
  assert.deepStrictEqual(sumas(x)['2'], { P1: { 1: 2 }, P2: { 1: 2 } });
  assert.deepStrictEqual(C.sospechososDe(x), ['3']);
});
prueba('insertar antes del primero: el nuevo se lleva clave, armadura y compás', () => {
  const x = C.insertarCompas(XML, 1, true);
  assert.match(cuerpoDe(x, 'P2', 1), /<clef><sign>F<\/sign>/);
  assert.match(cuerpoDe(x, 'P2', 1), /<time>/);
  assert.ok(!/<clef>/.test(cuerpoDe(x, 'P2', 2)));
  assert.deepStrictEqual(sumas(x)['1'], { P1: { 1: 2 }, P2: { 1: 2 } });
  assert.deepStrictEqual(C.sospechososDe(x), ['3']);
});
prueba('quitar el compás 2: quedan 2 y la barra doble pasa al anterior', () => {
  const x = C.quitarCompas(XML, 2);
  assert.deepStrictEqual(numeros(x), [['P1', ['1', '2']], ['P2', ['1', '2']]]);
  assert.match(cuerpoDe(x, 'P1', 1), /light-light/);
  assert.deepStrictEqual(C.sospechososDe(x), []);
  assert.deepStrictEqual(sumas(x)['2'], { P1: { 1: 2 }, P2: { 1: 2 } });
});
prueba('quitar el primero: el siguiente hereda clave, armadura, compás y divisiones', () => {
  const x = C.quitarCompas(XML, 1);
  const c = cuerpoDe(x, 'P2', 1);
  assert.match(c, /<divisions>2<\/divisions>/); assert.match(c, /<fifths>-1<\/fifths>/); assert.match(c, /<beats>2<\/beats>/); assert.match(c, /<sign>F<\/sign>/);
  assert.deepStrictEqual(C.sospechososDe(x), ['1']);
});

// Dos voces en el mismo pentagrama (con <backup>)
const V2 = compas(1, ATTR1 + nota('G', 4, 'half', 4, letra('la')) + '<backup><duration>4</duration></backup>' + nota('E', 4, 'quarter', 2).replace('<voice>1', '<voice>2') + nota('D', 4, 'quarter', 2).replace('<voice>1', '<voice>2'));
const XML2 = obra([{ id: 'P1', nombre: 'Sola', compases: [V2, compas(2, nota('C', 4, 'half', 4))] }]);
console.log('Dos voces en un pentagrama');
prueba('al partir, cada mitad conserva las dos voces con su <backup>', () => {
  const x = C.partirCompas(XML2, 1, 1);
  const s = sumas(x);
  assert.deepStrictEqual(s['1'], { P1: { 1: 1, 2: 1 } });
  assert.deepStrictEqual(s['2'], { P1: { 1: 1, 2: 1 } });
  assert.match(cuerpoDe(x, 'P1', 1), /<backup><duration>2<\/duration><\/backup>/);
  assert.match(cuerpoDe(x, 'P1', 2), /<backup><duration>2<\/duration><\/backup>/);
  assert.deepStrictEqual(C.sospechososDe(x), ['1', '2']); // 1 negra en 2/4: no cuadran (a propósito)
  const y = C.fundirCompases(x, 1);
  assert.deepStrictEqual(sumas(y)['1'], { P1: { 1: 2, 2: 2 } });
  assert.deepStrictEqual(C.sospechososDe(y), []);
});
prueba('posicionDeNota da la negra en la que empieza cada nota', () => {
  assert.strictEqual(C.posicionDeNota(XML, 2, 'P1', 0), 0);
  assert.strictEqual(C.posicionDeNota(XML, 2, 'P1', 2), 1.5);
  assert.strictEqual(C.posicionDeNota(XML, 2, 'P1', 3), 2);
  assert.strictEqual(C.posicionDeNota(XML2, 1, 'P1', 2), 1);
  assert.strictEqual(C.posicionDeNota(XML, 2, 'P1', 9), null);
  assert.deepStrictEqual(C.duracionCompas(XML, 2), { dura: 4, esperado: 2, beats: 2, bt: 4 });
});

// El borrador de prueba, si está
const ruta = path.join(__dirname, '..', '..', 'borradores', 'b261101115701jr1', 'partituras', '1_Nosotros_hemos_de_gloriarnos.xml');
if (fs.existsSync(ruta)) {
  console.log('Borrador «1. Nosotros hemos de gloriarnos»');
  const xml = fs.readFileSync(ruta, 'utf8');
  const n0 = numeros(xml)[0][1].length, sosp0 = C.sospechososDe(xml);
  prueba('partir el compás 15 (4 negras en 2/4) en la negra 2: un compás más en las dos voces y el 16 nuevo cuadra', () => {
    assert.ok(sosp0.includes('15'));
    const x = C.partirCompas(xml, 15, 2);
    for (const [, nums] of numeros(x)) { assert.strictEqual(nums.length, n0 + 1); assert.deepStrictEqual(nums, nums.map((_, i) => String(i + 1))); }
    const s = sumas(x);
    assert.strictEqual(s['15'].P1[1], 2); assert.strictEqual(s['16'].P1[1], 2);
    assert.ok(C.sospechososDe(x).length <= sosp0.length + 1, 'no empeora');
    assert.deepStrictEqual(sumas(x)['17'], sumas(xml)['16']);
    assert.deepStrictEqual(sumas(x)['62'], sumas(xml)['61']);
  });
  prueba('fundir el 42 con el 43: un compás menos, suma 4.5 en la Soprano con su segunda voz', () => {
    const x = C.fundirCompases(xml, 42);
    for (const [, nums] of numeros(x)) assert.strictEqual(nums.length, n0 - 1);
    assert.deepStrictEqual(sumas(x)['42'].P1, { 1: 4.5, 2: 2 });
    assert.deepStrictEqual(sumas(x)['42'].P2, { 1: 2 }); // dos silencios de compás entero → uno
    assert.deepStrictEqual(sumas(x)['43'], sumas(xml)['44']);
    assert.match(cuerpoDe(x, 'P1', 43), /light-light/);
  });
  prueba('insertar y quitar devuelven el número de compases esperado y el XML se sigue leyendo', () => {
    const x = C.quitarCompas(C.insertarCompas(xml, 30, true), 31);
    for (const [, nums] of numeros(x)) assert.strictEqual(nums.length, n0);
    assert.deepStrictEqual(sumas(x), sumas(xml));
    assert.deepStrictEqual(C.sospechososDe(x), sosp0);
  });
}
console.log(process.exitCode ? 'Hay pruebas que fallan' : `Todo bien (${pruebas} pruebas)`);
