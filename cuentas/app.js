// Contabilidad de la Coral Villa de Mengíbar · tanda 1: libro, justificantes y tesorería.
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.49.4/+esm';
import { SUPABASE_URL, SUPABASE_KEY } from './config.js';

const app = document.getElementById('app');
const configurado = !SUPABASE_URL.startsWith('PENDIENTE');
const sb = configurado ? createClient(SUPABASE_URL, SUPABASE_KEY) : null;

// ======================================================================
// Utilidades
// ======================================================================
const $ = (sel, raiz = document) => raiz.querySelector(sel);
const $$ = (sel, raiz = document) => [...raiz.querySelectorAll(sel)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ico = (n, cls = '') => `<svg class="ico ${cls}" aria-hidden="true"><use href="#i-${n}"/></svg>`;
const fmtEur = new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' });
const eur = n => fmtEur.format(Number(n) || 0);
const fmtFecha = new Intl.DateTimeFormat('es-ES', { day: 'numeric', month: 'short', year: 'numeric' });
const fmtFechaHora = new Intl.DateTimeFormat('es-ES', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const fecha = d => (d ? fmtFecha.format(new Date(d.length === 10 ? d + 'T12:00:00' : d)) : '');
const fechaHora = d => (d ? fmtFechaHora.format(new Date(d)) : '');
const hoy = () => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 10); };
const numInput = n => (n === null || n === undefined || n === '' ? '' : Number(n).toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2, useGrouping: false }));
const ROLES = {
  admin: { nombre: 'Administrador', desc: 'Puede hacerlo todo, también dar de alta a otras personas.' },
  tesorero: { nombre: 'Tesorero', desc: 'Apunta y corrige ingresos y gastos, justificantes y cuentas.' },
  junta: { nombre: 'Junta', desc: 'Solo consulta: ve saldos, libro y justificantes, pero no cambia nada.' },
};
const TIPOS = { ingreso: 'Ingreso', gasto: 'Gasto', traspaso: 'Traspaso' };

// Acepta «12,50», «12.50», «1.234,56» y «-30»
function parseImporte(txt) {
  let s = String(txt ?? '').trim().replace(/[€\s]/g, '');
  if (!s) return NaN;
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  else if (/^-?\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '');
  if (!/^-?\d+(\.\d+)?$/.test(s)) return NaN;
  return Math.round(Number(s) * 100) / 100;
}

class ErrorHumano extends Error {}
function mensajeError(e) {
  if (e instanceof ErrorHumano) return e.message;
  const m = String(e?.message || e || '').toLowerCase();
  if (!navigator.onLine || m.includes('failed to fetch') || m.includes('networkerror') || m.includes('load failed'))
    return 'No hay conexión. Comprueba internet y vuelve a intentarlo.';
  if (m.includes('invalid login')) return 'El correo o la contraseña no son correctos.';
  if (m.includes('row-level security') || m.includes('permission denied') || e?.code === '42501')
    return 'Tu usuario no tiene permiso para hacer esto.';
  if (e?.code === '23514' && e.message && !m.includes('violates')) return e.message;   // mensajes propios de la base de datos
  if (e?.code === '23505') return 'Ya existe un elemento con ese nombre.';
  if (e?.code === '23514' || e?.code === '23502') return 'Algún dato no es válido. Revisa el formulario.';
  if (m.includes('jwt') || m.includes('refresh token')) return 'Tu sesión ha caducado. Vuelve a entrar.';
  if (m.includes('payload too large') || m.includes('exceeded the maximum')) return 'El archivo es demasiado grande (máximo 10 MB).';
  return 'Algo ha fallado. Vuelve a intentarlo en unos segundos.';
}

function descargar(nombre, contenido, tipo) {
  const url = URL.createObjectURL(new Blob([contenido], { type: tipo }));
  const a = Object.assign(document.createElement('a'), { href: url, download: nombre });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
const csvCelda = v => { const s = String(v ?? ''); return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const csv = filas => '﻿' + filas.map(f => f.map(csvCelda).join(';')).join('\r\n');
const csvNum = n => (n === null || n === undefined || n === '' ? '' : Number(n).toFixed(2).replace('.', ','));

function contrasenaProvisional() {
  const letras = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const v = crypto.getRandomValues(new Uint32Array(10));
  return [...v].map(x => letras[x % letras.length]).join('');
}
const slug = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-zA-Z0-9.]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'archivo';

// ======================================================================
// Estado
// ======================================================================
const E = {
  perfil: null, perfiles: [], ejercicio: new Date().getFullYear(), ejercicios: [],
  cuentas: [], categorias: [], ajustes: null, movs: [], filtro: {},
};
const puedeEditar = () => ['admin', 'tesorero'].includes(E.perfil?.rol);
const esAdmin = () => E.perfil?.rol === 'admin';
const cuenta = id => E.cuentas.find(c => c.id === id);
const categoria = id => E.categorias.find(c => c.id === id);
const nombrePerfil = id => E.perfiles.find(p => p.id === id)?.nombre || '';

async function q(promesa) {
  const { data, error } = await promesa;
  if (error) throw error;
  return data;
}

async function cargarMaestros() {
  const [cuentas, categorias, ajustes, perfiles, ejercicios] = await Promise.all([
    q(sb.from('saldos_cuentas').select('*').order('orden').order('nombre')),
    q(sb.from('categorias').select('*').order('tipo').order('orden').order('nombre')),
    q(sb.from('ajustes').select('*').eq('id', 1).maybeSingle()),
    q(sb.from('perfiles').select('id, nombre, email, rol, activo, creado_en').order('nombre')),
    q(sb.rpc('ejercicios')),
  ]);
  Object.assign(E, { cuentas, categorias, ajustes, perfiles });
  const actual = new Date().getFullYear();
  E.ejercicios = [...new Set([actual, ...ejercicios.map(Number)])].sort((a, b) => b - a);
  pintarSelectorEjercicio();
  const banda = $('#banda-pruebas'); if (banda) banda.hidden = !E.ajustes?.modo_pruebas;
}
async function cargarSaldos() {
  E.cuentas = await q(sb.from('saldos_cuentas').select('*').order('orden').order('nombre'));
}
async function cargarMovs() {
  const datos = await q(sb.from('movimientos').select('*, justificantes(count)')
    .eq('ejercicio', E.ejercicio).order('fecha', { ascending: false }).order('numero', { ascending: false }).limit(5000));
  E.movs = datos.map(m => ({ ...m, njust: m.justificantes?.[0]?.count ?? 0 }));
}

// ======================================================================
// Avisos flotantes, diálogos y confirmaciones
// ======================================================================
function tostada(texto, { deshacer, error } = {}) {
  let cont = $('.tostadas');
  if (!cont) { cont = Object.assign(document.createElement('div'), { className: 'tostadas' }); document.body.append(cont); }
  const t = document.createElement('div');
  t.className = 'tostada' + (error ? ' error' : '');
  t.setAttribute('role', error ? 'alert' : 'status');
  t.innerHTML = `<p>${esc(texto)}</p>${deshacer ? '<button type="button" class="btn btn-texto" data-t="deshacer">Deshacer</button>' : ''}
    <button type="button" class="btn btn-icono" data-t="cerrar" aria-label="Cerrar aviso">${ico('x', 'ico-s')}</button>`;
  const quitar = () => t.remove();
  t.addEventListener('click', async e => {
    const b = e.target.closest('[data-t]'); if (!b) return;
    quitar();
    if (b.dataset.t === 'deshacer') {
      try { await deshacer(); } catch (err) { tostada(mensajeError(err), { error: true }); }
    }
  });
  cont.append(t);
  setTimeout(quitar, deshacer ? 10000 : error ? 8000 : 5000);
}

function dialogo({ titulo, cuerpo, pie = '', cerrarFuera = true }) {
  const d = document.createElement('dialog');
  d.setAttribute('aria-labelledby', 'dlg-titulo-' + (dialogo.n = (dialogo.n || 0) + 1));
  d.innerHTML = `<div class="dialogo">
    <header><h2 id="dlg-titulo-${dialogo.n}">${esc(titulo)}</h2>
      <button type="button" class="btn btn-icono" data-cerrar aria-label="Cerrar">${ico('x')}</button></header>
    <div class="cuerpo">${cuerpo}</div>${pie ? `<footer>${pie}</footer>` : ''}</div>`;
  document.body.append(d);
  d.addEventListener('click', e => {
    if (e.target.closest('[data-cerrar]') || (cerrarFuera && e.target === d)) d.close();
  });
  d.addEventListener('close', () => d.remove());
  d.showModal();
  return d;
}

function confirmar({ titulo, texto, boton, peligro = false, motivo = false }) {
  return new Promise(resolver => {
    const d = dialogo({
      titulo,
      cuerpo: `<form class="formulario" id="f-conf" novalidate><p>${texto}</p>
        ${motivo ? `<div class="campo"><label for="c-motivo">${esc(motivo)}</label>
          <textarea id="c-motivo" required maxlength="300" aria-describedby="c-motivo-err"></textarea>
          <p class="error" id="c-motivo-err" hidden></p></div>` : ''}</form>`,
      pie: `<button type="button" class="btn" data-cerrar>Cancelar</button>
        <button type="submit" form="f-conf" class="btn ${peligro ? 'btn-peligro' : 'btn-primario'}">${esc(boton)}</button>`,
    });
    let hecho = false;
    $('#f-conf', d).addEventListener('submit', e => {
      e.preventDefault();
      const ta = $('#c-motivo', d);
      if (ta && !ta.value.trim()) { mostrarError(ta, 'Escribe el motivo: quedará anotado en el libro.'); ta.focus(); return; }
      hecho = true; resolver({ motivo: ta?.value.trim() }); d.close();
    });
    d.addEventListener('close', () => { if (!hecho) resolver(false); });
  });
}

function mostrarError(campo, texto) {
  const err = document.getElementById(campo.id + '-err');
  campo.setAttribute('aria-invalid', texto ? 'true' : 'false');
  if (err) { err.hidden = !texto; err.innerHTML = texto ? `${ico('alerta', 'ico-s')} ${esc(texto)}` : ''; }
}

async function conBoton(boton, fn) {
  if (boton) { boton.disabled = true; boton.classList.add('cargando'); boton.setAttribute('aria-busy', 'true'); }
  try { return await fn(); }
  finally { if (boton) { boton.disabled = false; boton.classList.remove('cargando'); boton.removeAttribute('aria-busy'); } }
}

// ======================================================================
// Acceso
// ======================================================================
async function llamarUsuarios(cuerpo) {
  const { data, error } = await sb.functions.invoke('usuarios', { body: cuerpo });
  if (error) {
    let msg = null;
    try { msg = (await error.context?.json())?.error; } catch {}
    if (msg) throw new ErrorHumano(msg);
    throw error;
  }
  return data;
}

const logoAcceso = '<div class="logo-acceso"><img src="logo-documentos.jpg" alt="Coral Villa de Mengíbar" width="700" height="305"></div>';

function pantallaSinConfigurar() {
  app.innerHTML = `<div class="acceso"><div class="tarjeta">
    ${logoAcceso}<h1>Cuentas de la coral</h1>
    <div class="aviso aviso-info">${ico('info')}<p>La app todavía no está conectada a su base de datos. Falta rellenar <code>config.js</code>.</p></div>
  </div></div>`;
}

async function pantallaAcceso(mensaje) {
  let hayAdmin = true;
  try { hayAdmin = (await llamarUsuarios({ accion: 'estado' })).hayAdmin; } catch { /* si falla, se muestra el acceso normal */ }
  if (!hayAdmin) return pantallaPrimerAdmin();

  app.innerHTML = `<main class="acceso"><form class="tarjeta" id="f-acceso" novalidate>
    ${logoAcceso}<h1>Cuentas de la coral</h1>
    ${mensaje ? `<div class="aviso aviso-info" role="status">${ico('info')}<p>${esc(mensaje)}</p></div>` : ''}
    <div class="campo"><label for="a-email">Correo electrónico</label>
      <input id="a-email" type="email" autocomplete="username" required aria-describedby="a-email-err">
      <p class="error" id="a-email-err" hidden></p></div>
    <div class="campo"><label for="a-pass">Contraseña</label>
      <input id="a-pass" type="password" autocomplete="current-password" required aria-describedby="a-pass-err">
      <p class="error" id="a-pass-err" hidden></p></div>
    <div class="aviso aviso-error" id="a-error" role="alert" hidden></div>
    <button class="btn btn-primario btn-grande btn-bloque" type="submit">Entrar</button>
    <p class="muted pequeno">¿Has olvidado la contraseña o aún no tienes acceso? Pídeselo al presidente: él te da de alta o te pone una contraseña nueva.</p>
  </form></main>`;
  const f = $('#f-acceso'), email = $('#a-email'), pass = $('#a-pass'), caja = $('#a-error');
  email.addEventListener('blur', () => mostrarError(email, email.value && !email.validity.valid ? 'Revisa el correo: parece incompleto.' : ''));
  f.addEventListener('submit', async e => {
    e.preventDefault();
    caja.hidden = true;
    mostrarError(email, !email.value.trim() ? 'Escribe tu correo.' : !email.validity.valid ? 'Revisa el correo: parece incompleto.' : '');
    mostrarError(pass, !pass.value ? 'Escribe tu contraseña.' : '');
    if (!email.validity.valid || !email.value || !pass.value) return (email.validity.valid && email.value ? pass : email).focus();
    await conBoton(f.querySelector('[type=submit]'), async () => {
      const { data, error } = await sb.auth.signInWithPassword({ email: email.value.trim(), password: pass.value });
      if (error) { caja.innerHTML = `${ico('alerta')}<p>${esc(mensajeError(error))}</p>`; caja.hidden = false; return; }
      await entrar(data.session);
    });
  });
  email.focus();
}

function pantallaPrimerAdmin() {
  app.innerHTML = `<main class="acceso"><form class="tarjeta" id="f-primero" novalidate>
    ${logoAcceso}<h1>Configura las cuentas de la coral</h1>
    <p class="muted">Es la primera vez que se abre. Crea tu usuario de administrador; después podrás dar de alta al tesorero y a la junta.</p>
    <div class="campo"><label for="p-nombre">Tu nombre</label><input id="p-nombre" autocomplete="name" required aria-describedby="p-nombre-err"><p class="error" id="p-nombre-err" hidden></p></div>
    <div class="campo"><label for="p-email">Correo electrónico</label><input id="p-email" type="email" autocomplete="email" required aria-describedby="p-email-err"><p class="error" id="p-email-err" hidden></p></div>
    <div class="campo"><label for="p-pass">Contraseña</label><input id="p-pass" type="password" autocomplete="new-password" minlength="8" required aria-describedby="p-pass-ayuda p-pass-err">
      <p class="ayuda" id="p-pass-ayuda">Al menos 8 caracteres.</p><p class="error" id="p-pass-err" hidden></p></div>
    <div class="aviso aviso-error" id="p-error" role="alert" hidden></div>
    <button class="btn btn-primario btn-grande btn-bloque" type="submit">Crear administrador y entrar</button>
  </form></main>`;
  const f = $('#f-primero');
  f.addEventListener('submit', async e => {
    e.preventDefault();
    const nombre = $('#p-nombre'), email = $('#p-email'), pass = $('#p-pass'), caja = $('#p-error');
    mostrarError(nombre, nombre.value.trim() ? '' : 'Escribe tu nombre.');
    mostrarError(email, email.value && email.validity.valid ? '' : 'Escribe un correo válido.');
    mostrarError(pass, pass.value.length >= 8 ? '' : 'La contraseña debe tener al menos 8 caracteres.');
    const malo = [nombre, email, pass].find(c => c.getAttribute('aria-invalid') === 'true');
    if (malo) return malo.focus();
    await conBoton(f.querySelector('[type=submit]'), async () => {
      try {
        await llamarUsuarios({ accion: 'primer-admin', nombre: nombre.value.trim(), email: email.value.trim(), password: pass.value });
        const { data, error } = await sb.auth.signInWithPassword({ email: email.value.trim(), password: pass.value });
        if (error) throw error;
        await entrar(data.session);
      } catch (err) { caja.innerHTML = `${ico('alerta')}<p>${esc(mensajeError(err))}</p>`; caja.hidden = false; }
    });
  });
}

async function entrar(sesion) {
  try {
    const perfil = await q(sb.from('perfiles').select('*').eq('id', sesion.user.id).maybeSingle());
    if (!perfil || !perfil.activo) {
      await sb.auth.signOut();
      return pantallaAcceso('Tu usuario no tiene acceso a las cuentas. Habla con el presidente.');
    }
    E.perfil = perfil;
    pintarMarco();
    await cargarMaestros();
    enrutar();
  } catch (e) {
    app.innerHTML = `<main class="acceso"><div class="tarjeta">
      <div class="aviso aviso-error" role="alert">${ico('alerta')}<p>${esc(mensajeError(e))}</p></div>
      <button class="btn btn-primario" id="b-reintentar">${ico('recargar')} Reintentar</button></div></main>`;
    $('#b-reintentar').onclick = () => location.reload();
  }
}

// ======================================================================
// Marco: cabecera, pestañas y rutas
// ======================================================================
const PESTANAS = [
  { ruta: 'inicio', nombre: 'Inicio', ico: 'inicio' },
  { ruta: 'libro', nombre: 'Libro', ico: 'libro' },
  { ruta: 'tesoreria', nombre: 'Tesorería', ico: 'banco' },
  { ruta: 'facturas', nombre: 'Facturas', ico: 'factura' },
  { ruta: 'subvenciones', nombre: 'Subvenciones', ico: 'subvencion' },
];
// Vistas sin pestaña propia: a qué pestaña pertenecen y qué título llevan
const SECCION_DE = { subvencion: 'subvenciones', memoria: 'inicio' };
const TITULOS = { ajustes: 'Ajustes', historial: 'Historial de cambios', subvencion: 'Subvención', memoria: 'Memoria anual' };

function pintarMarco() {
  app.innerHTML = `
    <header class="cabecera">
      <a class="marca" href="#inicio" style="color:inherit;text-decoration:none"><img src="lira.png" alt="" class="marca-lira" width="71" height="96"><span>Cuentas de la coral</span></a>
      <label class="sr" for="sel-ejercicio">Año</label>
      <select id="sel-ejercicio" class="no-imprimir"></select>
      <a class="btn btn-icono boton-ajustes no-imprimir" href="#ajustes" aria-label="Ajustes">${ico('ajustes')}</a>
    </header>
    <div class="aviso aviso-aviso banda-conexion" id="banda-red" role="status" hidden>${ico('sin-red')}
      <p>Sin conexión. Puedes consultar lo que ya está cargado, pero no guardar cambios hasta que vuelva.</p></div>
    <nav class="pestanas" aria-label="Secciones">
      ${PESTANAS.map(p => `<a href="#${p.ruta}" data-ruta="${p.ruta}">${ico(p.ico)}<span>${p.nombre}</span></a>`).join('')}
    </nav>
    <div class="banda-pruebas" id="banda-pruebas" role="note" hidden>${ico('info', 'ico-s')}
      <p><strong>Modo de pruebas.</strong> Lo que apuntéis ahora se podrá borrar antes de empezar de verdad.</p></div>
    <main id="vista" tabindex="-1"></main>`;
  $('#sel-ejercicio').addEventListener('change', e => { E.ejercicio = Number(e.target.value); enrutar(); });
  const red = () => { $('#banda-red').hidden = navigator.onLine; };
  addEventListener('online', red); addEventListener('offline', red); red();
}

function pintarSelectorEjercicio() {
  const sel = $('#sel-ejercicio'); if (!sel) return;
  sel.innerHTML = E.ejercicios.map(a => `<option value="${a}" ${a === E.ejercicio ? 'selected' : ''}>${a}</option>`).join('');
}

const VISTAS = { inicio: vistaInicio, libro: vistaLibro, tesoreria: vistaTesoreria, facturas: vistaFacturas, subvenciones: vistaSubvenciones,
  subvencion: vistaSubvencion, memoria: vistaMemoria, ajustes: vistaAjustes, historial: vistaHistorial };
let rutaAnterior = null;
function enrutar() {
  const [ruta, qs] = location.hash.slice(1).split('?');
  const nombre = VISTAS[ruta] ? ruta : 'inicio';
  const pestana = SECCION_DE[nombre] || nombre;
  $$('.pestanas a').forEach(a => {
    if (a.dataset.ruta === pestana) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
  const enAjustes = nombre === 'ajustes' || nombre === 'historial';
  $('.boton-ajustes')?.toggleAttribute('aria-current', enAjustes);
  document.title = `${TITULOS[nombre] || PESTANAS.find(p => p.ruta === pestana)?.nombre} · Cuentas de la coral`;
  if (rutaAnterior !== null && rutaAnterior !== nombre) { scrollTo(0, 0); $('#vista').focus({ preventScroll: true }); }
  rutaAnterior = nombre;
  VISTAS[nombre](new URLSearchParams(qs || ''));
}
addEventListener('hashchange', () => { if (E.perfil) enrutar(); });

function esqueleto(lineas = 4) {
  return `<div aria-busy="true" aria-label="Cargando" class="rejilla">
    <div class="esqueleto esq-titulo"></div>
    ${'<div class="esqueleto esq-bloque"></div>'.repeat(lineas)}</div>`;
}
function errorVista(v, e, reintentar) {
  v.innerHTML = `<div class="vacio">${ico('alerta')}<h2>No se han podido cargar los datos</h2>
    <p>${esc(mensajeError(e))}</p><button class="btn btn-primario" id="b-reint">${ico('recargar')} Reintentar</button></div>`;
  $('#b-reint').onclick = reintentar;
}

// Clics comunes en cualquier vista
document.addEventListener('click', e => {
  const b = e.target.closest('[data-a]');
  if (b) {
    const a = b.dataset.a;
    if (a === 'nuevo') formMovimiento({ tipo: b.dataset.tipo || 'gasto' });
    else if (a === 'traspaso') formMovimiento({ tipo: 'traspaso' });
    else if (a === 'recibo') formRecibo();
    return;
  }
  const fila = e.target.closest('[data-mov]');
  if (fila) abrirDetalle(fila.dataset.mov);
});

// ======================================================================
// Inicio
// ======================================================================
function filaApunte(m) {
  const cat = categoria(m.categoria_id)?.nombre || '';
  const cta = cuenta(m.cuenta_id)?.nombre || '';
  const dest = cuenta(m.cuenta_destino_id)?.nombre || '';
  const signo = m.tipo === 'ingreso' ? '+' : m.tipo === 'gasto' ? '−' : '';
  const clase = m.tipo === 'ingreso' ? 'positivo' : m.tipo === 'gasto' ? 'negativo' : '';
  const just = m.njust
    ? `<span class="etiqueta">${ico('clip', 'ico-s')}<span class="sr">Justificantes:</span> ${m.njust}</span>`
    : m.tipo === 'gasto' && !m.anulado ? '<span class="etiqueta etiqueta-aviso">Sin justificante</span>' : '';
  return `<li><button type="button" class="fila ${m.anulado ? 'anulada' : ''}" data-mov="${m.id}">
    <span class="concepto">${esc(m.concepto)}</span>
    <span class="importe num ${clase}"><span class="sr">${TIPOS[m.tipo]} de </span>${signo}${eur(m.importe)}</span>
    <span class="meta">
      <span class="num">Nº ${m.numero}</span><span>${fecha(m.fecha)}</span>
      <span>${m.tipo === 'traspaso' ? `${esc(cta)} → ${esc(dest)}` : `${esc(cat)} · ${esc(cta)}`}</span>
      ${m.tercero ? `<span>${esc(m.tercero)}</span>` : ''}
      ${m.anulado ? '<span class="etiqueta etiqueta-error">Anulado</span>' : ''}${just}
    </span></button></li>`;
}

function totales(movs) {
  const vivos = movs.filter(m => !m.anulado);
  const ingresos = vivos.filter(m => m.tipo === 'ingreso').reduce((s, m) => s + Number(m.importe), 0);
  const gastos = vivos.filter(m => m.tipo === 'gasto').reduce((s, m) => s + Number(m.importe), 0);
  return { ingresos, gastos, resultado: ingresos - gastos };
}

function tablaCategorias(tipo, movs) {
  const suma = new Map();
  movs.filter(m => !m.anulado && m.tipo === tipo).forEach(m => suma.set(m.categoria_id, (suma.get(m.categoria_id) || 0) + Number(m.importe)));
  const total = [...suma.values()].reduce((a, b) => a + b, 0);
  const filas = [...suma.entries()].sort((a, b) => b[1] - a[1]);
  const titulo = tipo === 'ingreso' ? 'Ingresos por categoría' : 'Gastos por categoría';
  if (!filas.length) return `<section class="tarjeta"><h2>${titulo}</h2><p class="muted" style="margin-top:var(--space-2)">Sin ${tipo === 'ingreso' ? 'ingresos' : 'gastos'} este año.</p></section>`;
  return `<section class="tarjeta"><h2>${titulo}</h2>
    <table class="tabla-categorias"><caption class="sr">${titulo} en ${E.ejercicio}</caption>
      <thead><tr><th scope="col">Categoría</th><th scope="col">%</th><th scope="col">Importe</th></tr></thead>
      <tbody>${filas.map(([id, v]) => `<tr><td>${esc(categoria(id)?.nombre || 'Sin categoría')}</td>
        <td class="num muted">${Math.round((v / total) * 100)} %</td><td class="num">${eur(v)}</td></tr>`).join('')}</tbody>
      <tfoot><tr><th scope="row">Total</th><td></td><td class="num"><strong>${eur(total)}</strong></td></tr></tfoot>
    </table></section>`;
}

async function vistaInicio() {
  const v = $('#vista');
  v.innerHTML = esqueleto(3);
  let pendientes = [], plazos = [];
  try {
    [, , pendientes, plazos] = await Promise.all([cargarSaldos(), cargarMovs(),
      q(sb.from('documentos').select('id, total').eq('tipo', 'factura').eq('estado', 'emitida')),
      q(sb.from('subvenciones').select('id, convocatoria, plazo_justificacion, estado').eq('estado', 'concedida')
        .not('plazo_justificacion', 'is', null).lte('plazo_justificacion', sumarDias(hoy(), 30)).order('plazo_justificacion'))]);
  } catch (e) { return errorVista(v, e, vistaInicio); }
  const activas = E.cuentas.filter(c => c.activa);
  const total = activas.reduce((s, c) => s + Number(c.saldo), 0);
  const t = totales(E.movs);
  const sinJust = E.movs.filter(m => m.tipo === 'gasto' && !m.anulado && !m.njust).length;
  const hayBanco = E.cuentas.some(c => c.tipo === 'banco');

  v.innerHTML = `
    <div class="encabezado-vista"><h1>Resumen ${E.ejercicio}</h1>
      <a class="btn btn-texto" href="#memoria">${ico('grafico', 'ico-s')} Memoria del año</a></div>
    ${plazos.map(s => { const dd = diasHasta(s.plazo_justificacion); return `<div class="aviso ${dd < 0 ? 'aviso-error' : 'aviso-aviso'}" style="margin-bottom:var(--space-3)">${ico('alerta')}
      <p>${dd < 0 ? `Se pasó el plazo para justificar «${esc(s.convocatoria)}» (${fecha(s.plazo_justificacion)}).`
        : `Quedan ${dd} ${dd === 1 ? 'día' : 'días'} para justificar «${esc(s.convocatoria)}» (hasta el ${fecha(s.plazo_justificacion)}).`}</p>
      <a class="btn btn-texto acciones" href="#subvencion?id=${s.id}">Ver subvención</a></div>`; }).join('')}
    ${puedeEditar() ? `<div class="accion-principal">
      <button type="button" class="btn btn-primario btn-grande" data-a="nuevo" data-tipo="gasto">${ico('mas')} Apuntar gasto</button>
      <button type="button" class="btn btn-grande" data-a="nuevo" data-tipo="ingreso">${ico('mas')} Apuntar ingreso</button>
      <button type="button" class="btn btn-grande" data-a="recibo">${ico('lapiz')} Recibo firmado</button>
    </div>` : ''}
    ${puedeEditar() && !hayBanco ? `<div class="aviso aviso-info" style="margin-bottom:var(--space-4)">${ico('info')}
      <p>Para empezar, añade la cuenta del banco con el saldo que tiene hoy y cuenta el efectivo de la caja.</p>
      <a class="btn btn-texto acciones" href="#tesoreria">Ir a Tesorería</a></div>` : ''}
    <div class="rejilla rejilla-2">
      <section class="tarjeta saldo-total" aria-labelledby="t-saldo">
        <h2 id="t-saldo" class="muted pequeno">Dinero disponible ahora</h2>
        <p class="cifra num ${total < 0 ? 'negativo' : ''}">${eur(total)}</p>
        <ul class="lista-saldos">${activas.map(c => `<li><span class="nombre">${ico(c.tipo === 'caja' ? 'caja' : 'banco', 'ico-s')} ${esc(c.nombre)}</span>
          <span class="num ${Number(c.saldo) < 0 ? 'negativo' : ''}">${eur(c.saldo)}</span></li>`).join('')}</ul>
        <a href="#tesoreria" class="pequeno">Ver tesorería</a>
      </section>
      <section class="tarjeta" aria-labelledby="t-anio">
        <h2 id="t-anio" class="muted pequeno">Año ${E.ejercicio}</h2>
        <div class="rejilla rejilla-3" style="margin-top:var(--space-3)">
          <div class="kpi"><span class="muted pequeno">Ingresos</span><span class="cifra num positivo">${eur(t.ingresos)}</span></div>
          <div class="kpi"><span class="muted pequeno">Gastos</span><span class="cifra num negativo">${eur(t.gastos)}</span></div>
          <div class="kpi"><span class="muted pequeno">${t.resultado >= 0 ? 'Superávit' : 'Déficit'}</span>
            <span class="cifra num ${t.resultado >= 0 ? 'positivo' : 'negativo'}">${eur(t.resultado)}</span></div>
        </div>
      </section>
    </div>
    ${pendientes.length ? `<div class="aviso aviso-info" style="margin-top:var(--space-4)">${ico('factura')}
      <p>${pendientes.length === 1 ? 'Hay 1 factura pendiente' : `Hay ${pendientes.length} facturas pendientes`} de cobro: <strong class="num">${eur(pendientes.reduce((a, d) => a + Number(d.total), 0))}</strong>.</p>
      <a class="btn btn-texto acciones" href="#facturas?ver=facturas">Ver facturas</a></div>` : ''}
    ${sinJust ? `<div class="aviso aviso-aviso" style="margin-top:var(--space-4)">${ico('alerta')}
      <p>${sinJust === 1 ? 'Hay 1 gasto' : `Hay ${sinJust} gastos`} sin justificante este año.</p>
      <a class="btn btn-texto acciones" href="#libro?sinjust=1">Ver cuáles</a></div>` : ''}
    ${E.movs.length ? `
      <div class="rejilla rejilla-2 seccion">${tablaCategorias('ingreso', E.movs)}${tablaCategorias('gasto', E.movs)}</div>
      <section class="seccion" aria-labelledby="t-ult">
        <div class="encabezado-vista"><h2 id="t-ult">Últimos apuntes</h2><a href="#libro" class="btn btn-texto">Ver el libro completo</a></div>
        <ul class="lista-apuntes">${E.movs.slice(0, 5).map(filaApunte).join('')}</ul>
      </section>` : `
      <div class="vacio seccion">${ico('libro')}<h2>Todavía no hay apuntes en ${E.ejercicio}</h2>
        <p>${puedeEditar() ? 'El libro empieza con el primer ingreso o gasto que apuntes.' : 'Cuando el tesorero apunte ingresos o gastos, aparecerán aquí.'}</p></div>`}`;
}

// ======================================================================
// Libro de ingresos y gastos
// ======================================================================
function filtrar(movs, f) {
  const texto = (f.q || '').trim().toLowerCase();
  return movs.filter(m =>
    (f.anulados || !m.anulado) &&
    (!f.tipo || m.tipo === f.tipo) &&
    (!f.cuenta || m.cuenta_id === f.cuenta || m.cuenta_destino_id === f.cuenta) &&
    (!f.categoria || m.categoria_id === f.categoria) &&
    (!f.sinjust || (m.tipo === 'gasto' && !m.njust)) &&
    (!texto || `${m.numero} ${m.concepto} ${m.tercero || ''} ${m.notas || ''}`.toLowerCase().includes(texto)));
}

async function vistaLibro(params) {
  const v = $('#vista');
  E.filtro = { q: '', tipo: '', cuenta: params.get('cuenta') || '', categoria: '', sinjust: params.get('sinjust') === '1', anulados: false };
  v.innerHTML = esqueleto(5);
  try { await cargarMovs(); } catch (e) { return errorVista(v, e, () => vistaLibro(params)); }
  const f = E.filtro;
  const opcCuentas = E.cuentas.map(c => `<option value="${c.id}" ${f.cuenta === c.id ? 'selected' : ''}>${esc(c.nombre)}</option>`).join('');
  const opcCat = tipo => E.categorias.filter(c => c.tipo === tipo).map(c => `<option value="${c.id}">${esc(c.nombre)}</option>`).join('');

  v.innerHTML = `
    <div class="encabezado-vista"><h1>Libro de ingresos y gastos ${E.ejercicio}</h1>
      <button type="button" class="btn no-imprimir" id="b-csv">${ico('descargar')} Descargar en Excel</button>
      <button type="button" class="btn btn-icono no-imprimir" id="b-imprimir" aria-label="Imprimir el libro">${ico('imprimir')}</button>
      ${puedeEditar() ? `<button type="button" class="btn btn-primario no-imprimir" data-a="nuevo">${ico('mas')} Apuntar</button>` : ''}
    </div>
    <div class="filtros no-imprimir" role="search">
      <div class="campo buscar"><label for="f-q">Buscar</label>
        <input id="f-q" type="search" placeholder="Concepto, persona o nº de apunte" autocomplete="off"></div>
      <div class="campo"><label for="f-tipo">Tipo</label><select id="f-tipo">
        <option value="">Todos</option><option value="ingreso">Ingresos</option><option value="gasto">Gastos</option><option value="traspaso">Traspasos</option></select></div>
      <div class="campo"><label for="f-cuenta">Caja o banco</label><select id="f-cuenta"><option value="">Todas</option>${opcCuentas}</select></div>
      <div class="campo"><label for="f-cat">Categoría</label><select id="f-cat"><option value="">Todas</option>
        <optgroup label="Ingresos">${opcCat('ingreso')}</optgroup><optgroup label="Gastos">${opcCat('gasto')}</optgroup></select></div>
      <div class="casillas">
        <label class="casilla"><input type="checkbox" id="f-sinjust" ${f.sinjust ? 'checked' : ''}> Solo gastos sin justificante</label>
        <label class="casilla"><input type="checkbox" id="f-anulados"> Mostrar anulados</label>
      </div>
    </div>
    <div class="resumen-libro" id="resumen" aria-live="polite"></div>
    <div id="lista"></div>`;

  const pintar = () => {
    const lista = filtrar(E.movs, f);
    const t = totales(lista);
    $('#resumen').innerHTML = `<span><strong>${lista.length}</strong> ${lista.length === 1 ? 'apunte' : 'apuntes'}</span>
      <span>Ingresos <strong class="num positivo">${eur(t.ingresos)}</strong></span>
      <span>Gastos <strong class="num negativo">${eur(t.gastos)}</strong></span>
      <span>Diferencia <strong class="num">${eur(t.resultado)}</strong></span>`;
    const filtrando = f.q || f.tipo || f.cuenta || f.categoria || f.sinjust;
    $('#lista').innerHTML = lista.length ? `<ul class="lista-apuntes">${lista.map(filaApunte).join('')}</ul>`
      : filtrando ? `<div class="vacio">${ico('buscar')}<h2>Ningún apunte coincide</h2><p>Prueba a quitar algún filtro o a buscar otra palabra.</p>
          <button type="button" class="btn" id="b-limpiar">Quitar filtros</button></div>`
      : `<div class="vacio">${ico('vacio')}<h2>El libro de ${E.ejercicio} está vacío</h2>
          <p>${puedeEditar() ? 'Apunta el primer ingreso o gasto y aparecerá aquí con su número.' : 'Todavía no hay apuntes este año.'}</p>
          ${puedeEditar() ? `<button type="button" class="btn btn-primario" data-a="nuevo">${ico('mas')} Apuntar el primero</button>` : ''}</div>`;
    $('#b-limpiar')?.addEventListener('click', () => {
      Object.assign(f, { q: '', tipo: '', cuenta: '', categoria: '', sinjust: false });
      $('#f-q').value = ''; $('#f-tipo').value = ''; $('#f-cuenta').value = ''; $('#f-cat').value = ''; $('#f-sinjust').checked = false;
      pintar();
    });
  };
  let temporizador;
  $('#f-q').addEventListener('input', e => { clearTimeout(temporizador); temporizador = setTimeout(() => { f.q = e.target.value; pintar(); }, 200); });
  $('#f-tipo').addEventListener('change', e => { f.tipo = e.target.value; pintar(); });
  $('#f-cuenta').addEventListener('change', e => { f.cuenta = e.target.value; pintar(); });
  $('#f-cat').addEventListener('change', e => { f.categoria = e.target.value; pintar(); });
  $('#f-sinjust').addEventListener('change', e => { f.sinjust = e.target.checked; pintar(); });
  $('#f-anulados').addEventListener('change', e => { f.anulados = e.target.checked; pintar(); });
  $('#b-csv').addEventListener('click', () => descargarLibro(filtrar(E.movs, { ...f, anulados: true }), `libro-${E.ejercicio}.csv`));
  $('#b-imprimir').addEventListener('click', () => print());
  pintar();
}

function descargarLibro(movs, nombre) {
  const cab = ['Nº', 'Año', 'Fecha', 'Tipo', 'Concepto', 'Pagado a / recibido de', 'Categoría', 'Cuenta', 'Cuenta destino',
    'Ingreso', 'Gasto', 'Justificantes', 'Comprobado con banco', 'Anulado', 'Motivo anulación', 'Notas'];
  const filas = [...movs].sort((a, b) => a.ejercicio - b.ejercicio || a.numero - b.numero).map(m => [
    m.numero, m.ejercicio, m.fecha.split('-').reverse().join('/'), TIPOS[m.tipo], m.concepto, m.tercero || '',
    categoria(m.categoria_id)?.nombre || '', cuenta(m.cuenta_id)?.nombre || '', cuenta(m.cuenta_destino_id)?.nombre || '',
    m.tipo === 'ingreso' ? csvNum(m.importe) : '', m.tipo === 'gasto' ? csvNum(m.importe) : '',
    m.njust ?? '', m.conciliado ? 'Sí' : 'No', m.anulado ? 'Sí' : 'No', m.motivo_anulacion || '', m.notas || '']);
  descargar(nombre, csv([cab, ...filas]), 'text/csv;charset=utf-8');
}

// ======================================================================
// Detalle de un apunte
// ======================================================================
async function abrirDetalle(id) {
  let m = E.movs.find(x => x.id === id);
  try {
    if (!m) m = await q(sb.from('movimientos').select('*').eq('id', id).single());
  } catch (e) { return tostada(mensajeError(e), { error: true }); }
  const d = dialogo({
    titulo: `Apunte nº ${m.numero} de ${m.ejercicio}`,
    cuerpo: `<div id="det-cuerpo"></div>`,
    pie: puedeEditar() ? `
      ${m.anulado ? `<button type="button" class="btn izquierda" id="b-reactivar">${ico('deshacer')} Reactivar</button>`
        : `<button type="button" class="btn btn-texto izquierda" id="b-anular">${ico('anular')} Anular</button>`}
      ${m.anulado ? '' : `<button type="button" class="btn btn-primario" id="b-editar">${ico('lapiz')} Editar</button>`}`
      : `<button type="button" class="btn" data-cerrar>Cerrar</button>`,
  });
  const cuerpo = $('#det-cuerpo', d);
  const clase = m.tipo === 'ingreso' ? 'positivo' : m.tipo === 'gasto' ? 'negativo' : '';
  cuerpo.innerHTML = `
    ${m.anulado ? `<div class="aviso aviso-error" style="margin-bottom:var(--space-4)">${ico('anular')}
      <p><strong>Anulado.</strong> No cuenta en los saldos. Motivo: ${esc(m.motivo_anulacion || 'sin indicar')}</p></div>` : ''}
    <p class="num ${clase}" style="font-size:var(--font-xxl);font-weight:700">${m.tipo === 'gasto' ? '−' : m.tipo === 'ingreso' ? '+' : ''}${eur(m.importe)}</p>
    <p style="font-size:var(--font-l);font-weight:600;margin-bottom:var(--space-4)">${esc(m.concepto)}</p>
    <dl class="datos">
      <dt>Tipo</dt><dd>${TIPOS[m.tipo]}</dd>
      <dt>Fecha</dt><dd>${fecha(m.fecha)}</dd>
      ${m.tipo === 'traspaso'
        ? `<dt>Sale de</dt><dd>${esc(cuenta(m.cuenta_id)?.nombre)}</dd><dt>Entra en</dt><dd>${esc(cuenta(m.cuenta_destino_id)?.nombre)}</dd>`
        : `<dt>Categoría</dt><dd>${esc(categoria(m.categoria_id)?.nombre)}</dd><dt>${m.tipo === 'gasto' ? 'Pagado con' : 'Cobrado en'}</dt><dd>${esc(cuenta(m.cuenta_id)?.nombre)}</dd>`}
      ${m.tercero ? `<dt>${m.tipo === 'gasto' ? 'Pagado a' : 'Recibido de'}</dt><dd>${esc(m.tercero)}</dd>` : ''}
      ${m.notas ? `<dt>Notas</dt><dd>${esc(m.notas)}</dd>` : ''}
      <dt>Comprobado</dt><dd>${m.conciliado ? `${ico('ok', 'ico-s')} Cuadrado con el extracto` : 'Aún no'}</dd>
      <dt>Apuntado por</dt><dd>${esc(nombrePerfil(m.creado_por) || '—')} · ${fechaHora(m.creado_en)}</dd>
    </dl>
    <section class="seccion" aria-labelledby="t-just">
      <h3 id="t-just" style="margin-bottom:var(--space-2)">Justificantes</h3>
      <div id="det-just" aria-busy="true"><div class="esqueleto esq-bloque"></div></div>
    </section>`;
  pintarJustificantes(m, $('#det-just', d));
  // Si es el cobro de una factura: enlace a ella, y no se anula desde aquí (se deshace el cobro en la factura)
  sb.from('documentos').select('id, codigo').eq('movimiento_id', m.id).maybeSingle().then(({ data: fac }) => {
    if (!fac || !d.open) return;
    $('.datos', d).insertAdjacentHTML('beforeend', `<dt>Factura</dt><dd><button type="button" class="btn btn-texto" id="b-ver-fac" style="padding:0">${ico('factura', 'ico-s')} ${esc(fac.codigo)}</button></dd>`);
    $('#b-ver-fac', d).onclick = () => { d.close(); abrirDocumento(fac.id); };
    const an = $('#b-anular', d);
    if (an) an.outerHTML = `<p class="muted pequeno izquierda" style="max-width:32ch">Es el cobro de la factura ${esc(fac.codigo)}: para anularlo, usa «Deshacer cobro» en la factura.</p>`;
  });
  // Subvención: si es un cobro de subvención o un gasto que la justifica
  Promise.all([
    m.subvencion_id ? sb.from('subvenciones').select('id, convocatoria').eq('id', m.subvencion_id).maybeSingle().then(r => r.data) : null,
    sb.from('subvencion_gastos').select('importe, subvenciones(id, convocatoria)').eq('movimiento_id', m.id).then(r => r.data || []),
  ]).then(([cobroDe, justifica]) => {
    if (!d.open) return;
    const enlaces = [...(cobroDe ? [[cobroDe, 'Cobro de']] : []), ...justifica.map(j => [j.subvenciones, `Justifica (${eur(j.importe)})`])];
    if (!enlaces.length) return;
    $('.datos', d).insertAdjacentHTML('beforeend', `<dt>Subvención</dt><dd>${enlaces.map(([s, t]) =>
      `<a href="#subvencion?id=${s.id}" data-cerrar>${esc(t)} «${esc(s.convocatoria)}»</a>`).join('<br>')}</dd>`);
  });
  // Si tiene recibo firmado: enlace a él; si el apunte nació del recibo, se anula desde el recibo
  sb.from('recibos').select('id, codigo, documento_id').eq('movimiento_id', m.id).eq('anulado', false).maybeSingle().then(({ data: rec }) => {
    if (!rec || !d.open) return;
    $('.datos', d).insertAdjacentHTML('beforeend', `<dt>Recibo</dt><dd><button type="button" class="btn btn-texto" id="b-ver-rec" style="padding:0">${ico('lapiz', 'ico-s')} ${esc(rec.codigo)}</button></dd>`);
    $('#b-ver-rec', d).onclick = () => { d.close(); abrirRecibo(rec.id); };
    const an = $('#b-anular', d);
    if (an && !rec.documento_id) an.outerHTML = `<p class="muted pequeno izquierda" style="max-width:32ch">Es el recibo ${esc(rec.codigo)}: para anularlo, usa «Anular recibo».</p>`;
  });

  $('#b-editar', d)?.addEventListener('click', () => { d.close(); formMovimiento({ mov: m }); });
  $('#b-anular', d)?.addEventListener('click', async () => {
    const r = await confirmar({
      titulo: `¿Anular el apunte nº ${m.numero}?`,
      texto: 'Seguirá en el libro, tachado, pero dejará de contar en los saldos. Podrás reactivarlo cuando quieras.',
      boton: 'Anular apunte', peligro: true, motivo: 'Motivo de la anulación',
    });
    if (!r) return;
    try {
      await q(sb.from('movimientos').update({ anulado: true, motivo_anulacion: r.motivo }).eq('id', m.id));
      d.close(); await refrescar();
      tostada(`Apunte nº ${m.numero} anulado`, { deshacer: async () => { await q(sb.from('movimientos').update({ anulado: false, motivo_anulacion: null }).eq('id', m.id)); await refrescar(); } });
    } catch (e) { tostada(mensajeError(e), { error: true }); }
  });
  $('#b-reactivar', d)?.addEventListener('click', async e => {
    await conBoton(e.currentTarget, async () => {
      try {
        await q(sb.from('movimientos').update({ anulado: false, motivo_anulacion: null }).eq('id', m.id));
        d.close(); await refrescar(); tostada(`Apunte nº ${m.numero} reactivado`);
      } catch (err) { tostada(mensajeError(err), { error: true }); }
    });
  });
}

async function pintarJustificantes(m, cont) {
  let lista;
  try { lista = await q(sb.from('justificantes').select('*').eq('movimiento_id', m.id).order('subido_en')); }
  catch (e) { cont.removeAttribute('aria-busy'); cont.innerHTML = `<p class="error">${esc(mensajeError(e))}</p>`; return; }
  cont.removeAttribute('aria-busy');
  const editable = puedeEditar() && !m.anulado;
  cont.innerHTML = `
    ${lista.length ? `<ul class="lista-simple">${lista.map(j => `<li>
        ${ico(j.tipo_mime === 'application/pdf' ? 'archivo' : 'camara', 'ico-s')}
        <span class="crece">${esc(j.nombre)}<br><span class="muted pequeno">${fecha(j.subido_en)}${j.tamano ? ' · ' + Math.max(1, Math.round(j.tamano / 1024)) + ' KB' : ''}</span></span>
        <button type="button" class="btn btn-texto" data-ver="${j.id}">Ver</button>
        ${editable ? `<button type="button" class="btn btn-icono" data-quitar="${j.id}" aria-label="Quitar ${esc(j.nombre)}">${ico('papelera', 'ico-s')}</button>` : ''}
      </li>`).join('')}</ul>`
      : `<p class="muted">${m.tipo === 'gasto' ? 'Este gasto aún no tiene justificante.' : 'Sin justificantes.'}</p>`}
    ${editable ? `<div class="subir" style="margin-top:var(--space-3)">${botonesSubida('det')}</div>
      <p class="archivos-elegidos" id="det-estado" role="status"></p>` : ''}`;

  cont.querySelectorAll('[data-ver]').forEach(b => b.addEventListener('click', async () => {
    const j = lista.find(x => x.id === b.dataset.ver);
    const ventana = window.open('', '_blank');
    try {
      const { signedUrl } = await q(sb.storage.from('justificantes').createSignedUrl(j.ruta, 300));
      if (ventana) ventana.location = signedUrl; else location.href = signedUrl;
    } catch (e) { ventana?.close(); tostada(mensajeError(e), { error: true }); }
  }));
  cont.querySelectorAll('[data-quitar]').forEach(b => b.addEventListener('click', async () => {
    const j = lista.find(x => x.id === b.dataset.quitar);
    const r = await confirmar({ titulo: '¿Quitar este justificante?', texto: `Se borrará «${esc(j.nombre)}». Si te has equivocado de archivo, después puedes subir el correcto.`, boton: 'Quitar justificante', peligro: true });
    if (!r) return;
    try {
      await q(sb.from('justificantes').delete().eq('id', j.id));
      await sb.storage.from('justificantes').remove([j.ruta]);
      tostada('Justificante quitado');
      pintarJustificantes(m, cont); refrescarSilencioso();
    } catch (e) { tostada(mensajeError(e), { error: true }); }
  }));
  if (editable) conectarSubida(cont, 'det', async archivos => {
    const estado = $('#det-estado', cont);
    estado.textContent = archivos.length === 1 ? 'Subiendo el justificante…' : `Subiendo ${archivos.length} justificantes…`;
    try {
      await subirJustificantes(m, archivos);
      tostada(archivos.length === 1 ? 'Justificante guardado' : 'Justificantes guardados');
      pintarJustificantes(m, cont); refrescarSilencioso();
    } catch (e) { estado.textContent = ''; tostada(mensajeError(e), { error: true }); }
  });
}

function botonesSubida(pref) {
  return `<label class="btn" for="${pref}-camara">${ico('camara')} Hacer foto</label>
    <input type="file" id="${pref}-camara" accept="image/*" capture="environment">
    <label class="btn" for="${pref}-archivo">${ico('clip')} Elegir foto o PDF</label>
    <input type="file" id="${pref}-archivo" accept="image/*,application/pdf" multiple>`;
}
function conectarSubida(raiz, pref, alElegir) {
  [`#${pref}-camara`, `#${pref}-archivo`].forEach(sel => {
    const inp = $(sel, raiz);
    inp?.addEventListener('change', () => { if (inp.files.length) alElegir([...inp.files]); inp.value = ''; });
  });
}

async function comprimirImagen(archivo) {
  let bmp;
  try { bmp = await createImageBitmap(archivo); }
  catch { throw new ErrorHumano('No se puede leer esta foto. Hazla con la cámara desde aquí o guárdala como JPG.'); }
  const max = 2000, escala = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const lienzo = Object.assign(document.createElement('canvas'), { width: Math.round(bmp.width * escala), height: Math.round(bmp.height * escala) });
  lienzo.getContext('2d').drawImage(bmp, 0, 0, lienzo.width, lienzo.height);
  return new Promise((ok, mal) => lienzo.toBlob(b => (b ? ok(b) : mal(new ErrorHumano('No se pudo preparar la foto.'))), 'image/jpeg', 0.82));
}

async function subirJustificantes(m, archivos) {
  for (const a of archivos) {
    let blob = a, nombre = a.name || 'justificante', tipo = a.type;
    if (tipo.startsWith('image/')) { blob = await comprimirImagen(a); tipo = 'image/jpeg'; nombre = nombre.replace(/\.[^.]+$/, '') + '.jpg'; }
    else if (tipo !== 'application/pdf') throw new ErrorHumano(`«${nombre}» no es una foto ni un PDF.`);
    if (blob.size > 10 * 1024 * 1024) throw new ErrorHumano(`«${nombre}» ocupa más de 10 MB. Prueba a hacer una foto en vez de escanear.`);
    const ruta = `${m.ejercicio}/${m.id}/${crypto.randomUUID().slice(0, 8)}-${slug(nombre)}`;
    await q(sb.storage.from('justificantes').upload(ruta, blob, { contentType: tipo }));
    try { await q(sb.from('justificantes').insert({ movimiento_id: m.id, ruta, nombre, tipo_mime: tipo, tamano: blob.size })); }
    catch (e) { await sb.storage.from('justificantes').remove([ruta]); throw e; }
  }
}

// Tras guardar: recarga la vista actual (y los saldos)
async function refrescar() {
  try { await cargarMaestros(); } catch {}
  enrutar();
}
function refrescarSilencioso() { refrescar(); }

// ======================================================================
// Formulario de apunte (nuevo o editar)
// ======================================================================
function formMovimiento({ mov = null, tipo = 'gasto' } = {}) {
  const editando = !!mov;
  const cuentasActivas = E.cuentas.filter(c => c.activa || c.id === mov?.cuenta_id || c.id === mov?.cuenta_destino_id);
  if (!cuentasActivas.length) return tostada('Primero crea una cuenta en Tesorería.', { error: true });
  const sugerencias = (campo) => [...new Set(E.movs.map(m => m[campo]).filter(Boolean))].slice(0, 200)
    .map(s => `<option value="${esc(s)}"></option>`).join('');
  const opcCuentas = sel => cuentasActivas.map(c => `<option value="${c.id}" ${sel === c.id ? 'selected' : ''}>${esc(c.nombre)}</option>`).join('');
  const t0 = mov?.tipo || tipo;
  const cajaPorDefecto = mov?.cuenta_id || (cuentasActivas.find(c => c.tipo === (t0 === 'traspaso' ? 'caja' : 'banco')) || cuentasActivas[0]).id;

  const d = dialogo({
    titulo: editando ? `Editar apunte nº ${mov.numero}` : 'Nuevo apunte',
    cerrarFuera: false,
    cuerpo: `<form class="formulario" id="f-mov" novalidate>
      <fieldset class="campo" style="border:0;padding:0;margin:0"><legend class="etiqueta-campo" style="margin-bottom:var(--space-1)">Tipo de apunte</legend>
        <div class="segmentos">
          ${['gasto', 'ingreso', 'traspaso'].map(x => `<input type="radio" name="tipo" id="m-t-${x}" value="${x}" ${t0 === x ? 'checked' : ''}><label for="m-t-${x}">${TIPOS[x]}</label>`).join('')}
        </div></fieldset>
      <div class="fila-campos">
        <div class="campo"><label for="m-importe">Importe (€)</label>
          <input id="m-importe" class="input-importe" inputmode="decimal" autocomplete="off" required placeholder="0,00"
            value="${editando ? numInput(mov.importe) : ''}" aria-describedby="m-importe-err"><p class="error" id="m-importe-err" hidden></p></div>
        <div class="campo"><label for="m-fecha">Fecha</label>
          <input id="m-fecha" type="date" required value="${mov?.fecha || hoy()}" aria-describedby="m-fecha-err"><p class="error" id="m-fecha-err" hidden></p></div>
      </div>
      <div class="campo"><label for="m-concepto">Concepto</label>
        <input id="m-concepto" required maxlength="200" list="dl-conceptos" autocomplete="off" value="${esc(mov?.concepto || '')}"
          placeholder="Ej.: Boda de Ana y Luis, 12 de junio" aria-describedby="m-concepto-err">
        <datalist id="dl-conceptos">${sugerencias('concepto')}</datalist><p class="error" id="m-concepto-err" hidden></p></div>
      <div class="campo" data-solo="normal"><label for="m-cat">Categoría</label>
        <select id="m-cat" required aria-describedby="m-cat-err"></select><p class="error" id="m-cat-err" hidden></p></div>
      <div class="campo" data-solo="normal"><label for="m-cuenta" id="m-cuenta-label">Pagado con</label>
        <select id="m-cuenta" required>${opcCuentas(cajaPorDefecto)}</select></div>
      <div class="fila-campos" data-solo="traspaso">
        <div class="campo"><label for="m-desde">Sale de</label><select id="m-desde">${opcCuentas(mov?.cuenta_id || cuentasActivas.find(c => c.tipo === 'caja')?.id)}</select></div>
        <div class="campo"><label for="m-hacia">Entra en</label>
          <select id="m-hacia" aria-describedby="m-hacia-err">${opcCuentas(mov?.cuenta_destino_id || cuentasActivas.find(c => c.tipo === 'banco')?.id)}</select>
          <p class="error" id="m-hacia-err" hidden></p></div>
      </div>
      <div class="campo" data-solo="normal"><label for="m-tercero" id="m-tercero-label">Pagado a</label>
        <input id="m-tercero" maxlength="150" list="dl-terceros" autocomplete="off" value="${esc(mov?.tercero || '')}" aria-describedby="m-tercero-ayuda">
        <datalist id="dl-terceros">${sugerencias('tercero')}</datalist>
        <p class="ayuda" id="m-tercero-ayuda">Opcional. Persona, empresa o entidad.</p></div>
      <div class="campo"><label for="m-notas">Notas</label><textarea id="m-notas" maxlength="1000" aria-describedby="m-notas-ayuda">${esc(mov?.notas || '')}</textarea>
        <p class="ayuda" id="m-notas-ayuda">Opcional.</p></div>
      ${editando ? '' : `<div class="campo" data-solo="normal"><span class="etiqueta-campo">Justificante</span>
        <div class="subir">${botonesSubida('m')}</div>
        <p class="archivos-elegidos" id="m-elegidos" aria-live="polite">Opcional. También puedes añadirlo después.</p></div>`}
      <div class="aviso aviso-info" id="m-previo" role="status" hidden></div>
      <div class="aviso aviso-error" id="m-error" role="alert" hidden></div>
    </form>`,
    pie: `<button type="button" class="btn" data-cerrar>Cancelar</button>
      <button type="submit" form="f-mov" class="btn btn-primario">${editando ? 'Guardar cambios' : 'Guardar apunte'}</button>`,
  });

  const f = $('#f-mov', d);
  const tipoActual = () => $('input[name=tipo]:checked', f).value;
  let archivos = [];
  const pintarTipo = () => {
    const t = tipoActual();
    $$('[data-solo="normal"]', f).forEach(el => { el.hidden = t === 'traspaso'; });
    $$('[data-solo="traspaso"]', f).forEach(el => { el.hidden = t !== 'traspaso'; });
    $('#m-cuenta-label', f).textContent = t === 'gasto' ? 'Pagado con' : 'Cobrado en';
    $('#m-tercero-label', f).textContent = t === 'gasto' ? 'Pagado a' : 'Recibido de';
    $('#m-concepto', f).placeholder = t === 'gasto' ? 'Ej.: Partituras del concierto de Navidad' : t === 'ingreso' ? 'Ej.: Boda de Ana y Luis, 12 de junio' : 'Ej.: Ingreso en el banco del efectivo de la boda';
    const sel = $('#m-cat', f), previa = sel.value || mov?.categoria_id;
    if (t !== 'traspaso') {
      const cats = E.categorias.filter(c => c.tipo === t && (c.activa || c.id === mov?.categoria_id));
      sel.innerHTML = `<option value="">Elige una categoría</option>` + cats.map(c => `<option value="${c.id}" ${c.id === previa ? 'selected' : ''}>${esc(c.nombre)}</option>`).join('');
    }
  };
  // Aviso si la fecha es anterior al saldo inicial de la cuenta: el apunte sale en el libro pero no mueve el saldo
  const avisarPrevio = () => {
    const t = tipoActual(), fe = $('#m-fecha', f).value;
    const ids = t === 'traspaso' ? [$('#m-desde', f).value, $('#m-hacia', f).value] : [$('#m-cuenta', f).value];
    const afectadas = ids.map(cuenta).filter(c => c && fe && fe < c.fecha_inicial);
    const caja = $('#m-previo', f);
    caja.hidden = !afectadas.length;
    caja.innerHTML = afectadas.length ? `${ico('info')}<p>Es anterior al saldo inicial de ${afectadas.map(c => `«${esc(c.nombre)}» (${fecha(c.fecha_inicial)})`).join(' y ')}:
      aparecerá en el libro, pero no cambiará el saldo porque ya está incluido en él. Si no es así, corrige el saldo inicial en Tesorería.</p>` : '';
  };
  $$('input[name=tipo]', f).forEach(r => r.addEventListener('change', () => { pintarTipo(); avisarPrevio(); }));
  ['#m-fecha', '#m-cuenta', '#m-desde', '#m-hacia'].forEach(s => $(s, f).addEventListener('change', avisarPrevio));
  pintarTipo(); avisarPrevio();

  const imp = $('#m-importe', f), fec = $('#m-fecha', f), con = $('#m-concepto', f), cat = $('#m-cat', f), hacia = $('#m-hacia', f);
  const validar = {
    importe: () => { const n = parseImporte(imp.value); mostrarError(imp, !imp.value.trim() ? 'Escribe el importe.' : !(n > 0) ? 'Escribe un importe mayor que cero, por ejemplo 125,50.' : ''); return n > 0; },
    fecha: () => { mostrarError(fec, fec.value ? '' : 'Elige la fecha.'); return !!fec.value; },
    concepto: () => { mostrarError(con, con.value.trim() ? '' : 'Escribe un concepto para reconocer el apunte.'); return !!con.value.trim(); },
    cat: () => { if (tipoActual() === 'traspaso') return true; mostrarError(cat, cat.value ? '' : 'Elige una categoría.'); return !!cat.value; },
    hacia: () => { if (tipoActual() !== 'traspaso') return true; const ok = hacia.value !== $('#m-desde', f).value; mostrarError(hacia, ok ? '' : 'Elige una cuenta distinta de la de salida.'); return ok; },
  };
  imp.addEventListener('blur', () => { validar.importe(); const n = parseImporte(imp.value); if (n > 0) imp.value = numInput(n); });
  fec.addEventListener('blur', validar.fecha);
  con.addEventListener('blur', validar.concepto);
  cat.addEventListener('change', validar.cat);
  hacia.addEventListener('change', validar.hacia);
  if (!editando) conectarSubida(f, 'm', nuevos => {
    archivos = [...archivos, ...nuevos];
    $('#m-elegidos', f).textContent = `Se subirá${archivos.length > 1 ? 'n' : ''}: ${archivos.map(a => a.name || 'foto').join(', ')}`;
  });

  f.addEventListener('submit', async e => {
    e.preventDefault();
    const resultados = Object.values(validar).map(fn => fn());
    if (resultados.includes(false)) { f.querySelector('[aria-invalid="true"]')?.focus(); return; }
    const t = tipoActual();
    const datos = {
      tipo: t, fecha: fec.value, importe: parseImporte(imp.value), concepto: con.value.trim(),
      notas: $('#m-notas', f).value.trim() || null,
      tercero: t === 'traspaso' ? null : $('#m-tercero', f).value.trim() || null,
      categoria_id: t === 'traspaso' ? null : cat.value,
      cuenta_id: t === 'traspaso' ? $('#m-desde', f).value : $('#m-cuenta', f).value,
      cuenta_destino_id: t === 'traspaso' ? hacia.value : null,
    };
    const caja = $('#m-error', f);
    caja.hidden = true;
    await conBoton(d.querySelector('[type=submit]'), async () => {
      try {
        if (editando) {
          const antes = Object.fromEntries(Object.keys(datos).map(k => [k, mov[k]]));
          await q(sb.from('movimientos').update(datos).eq('id', mov.id));
          d.close(); await refrescar();
          tostada(`Apunte nº ${mov.numero} actualizado`, { deshacer: async () => { await q(sb.from('movimientos').update(antes).eq('id', mov.id)); await refrescar(); } });
        } else {
          const nuevo = await q(sb.from('movimientos').insert(datos).select().single());
          let avisoSubida = '';
          if (archivos.length && t !== 'traspaso') {
            try { await subirJustificantes(nuevo, archivos); } catch (err) { avisoSubida = ` El justificante no se pudo subir: ${mensajeError(err)}`; }
          }
          d.close();
          if (nuevo.ejercicio !== E.ejercicio) { E.ejercicio = nuevo.ejercicio; }
          await refrescar();
          tostada(`Apunte nº ${nuevo.numero} guardado.${avisoSubida}`, {
            error: !!avisoSubida,
            deshacer: avisoSubida ? null : async () => {
              await q(sb.from('movimientos').update({ anulado: true, motivo_anulacion: 'Deshecho justo después de apuntarlo' }).eq('id', nuevo.id));
              await refrescar();
            },
          });
        }
      } catch (err) {
        caja.innerHTML = `${ico('alerta')}<p>${esc(mensajeError(err))}</p>`; caja.hidden = false;
      }
    });
  });
  setTimeout(() => (editando ? con : imp).focus(), 50);
}

// ======================================================================
// Tesorería: caja y bancos
// ======================================================================
async function vistaTesoreria() {
  const v = $('#vista');
  v.innerHTML = esqueleto(3);
  let concs;
  try {
    await cargarSaldos();
    concs = await q(sb.from('conciliaciones').select('*').order('fecha', { ascending: false }).order('creado_en', { ascending: false }).limit(300));
  } catch (e) { return errorVista(v, e, vistaTesoreria); }
  const ultima = id => concs.find(c => c.cuenta_id === id);
  const activas = E.cuentas.filter(c => c.activa), cerradas = E.cuentas.filter(c => !c.activa);
  const total = activas.reduce((s, c) => s + Number(c.saldo), 0);

  const tarjeta = c => {
    const u = ultima(c.id), dif = u ? Number(u.saldo_extracto) - Number(u.saldo_app) : 0;
    return `<section class="tarjeta" aria-labelledby="cta-${c.id}">
      <div class="encabezado-vista" style="margin-bottom:var(--space-2)">
        <h2 id="cta-${c.id}" style="display:flex;gap:var(--space-2);align-items:center">${ico(c.tipo === 'caja' ? 'caja' : 'banco')} ${esc(c.nombre)}</h2>
        ${puedeEditar() ? `<button type="button" class="btn btn-icono" data-editar-cuenta="${c.id}" aria-label="Editar ${esc(c.nombre)}">${ico('lapiz', 'ico-s')}</button>` : ''}
      </div>
      ${c.detalle ? `<p class="muted pequeno">${esc(c.detalle)}</p>` : ''}
      <p class="num ${Number(c.saldo) < 0 ? 'negativo' : ''}" style="font-size:var(--font-xl);font-weight:700;margin:var(--space-2) 0">${eur(c.saldo)}</p>
      <p class="pequeno">${u
        ? `${Math.abs(dif) < 0.005 ? `<span class="etiqueta etiqueta-ok">${ico('ok', 'ico-s')} Cuadraba</span>` : `<span class="etiqueta etiqueta-aviso">${ico('alerta', 'ico-s')} Diferencia de ${eur(dif)}</span>`}
           <span class="muted">${c.tipo === 'caja' ? 'Último recuento' : 'Último cuadre'}: ${fecha(u.fecha)}</span>`
        : `<span class="muted">${c.tipo === 'caja' ? 'Aún no se ha contado el efectivo.' : 'Aún no se ha cuadrado con el extracto.'}</span>`}</p>
      ${Number(c.sin_conciliar) ? `<p class="pequeno muted">${c.sin_conciliar} ${Number(c.sin_conciliar) === 1 ? 'apunte' : 'apuntes'} sin comprobar</p>` : ''}
      <div style="display:flex;flex-wrap:wrap;gap:var(--space-2);margin-top:var(--space-3)">
        ${puedeEditar() && c.activa ? `<button type="button" class="btn" data-cuadrar="${c.id}">${ico('balanza')} ${c.tipo === 'caja' ? 'Contar el efectivo' : 'Cuadrar con el extracto'}</button>` : ''}
        <a class="btn btn-texto" href="#libro?cuenta=${c.id}">Ver apuntes</a>
      </div></section>`;
  };

  v.innerHTML = `
    <div class="encabezado-vista"><h1>Tesorería</h1>
      ${puedeEditar() ? `<button type="button" class="btn" data-a="traspaso">${ico('traspaso')} Traspaso entre cuentas</button>
        <button type="button" class="btn btn-primario" id="b-nueva-cuenta">${ico('mas')} Añadir cuenta</button>` : ''}
    </div>
    <p class="muted" style="margin-bottom:var(--space-4)">Total en caja y bancos: <strong class="num">${eur(total)}</strong></p>
    ${activas.length ? `<div class="rejilla rejilla-2">${activas.map(tarjeta).join('')}</div>`
      : `<div class="vacio">${ico('banco')}<h2>No hay cuentas</h2><p>Añade la caja de efectivo y las cuentas del banco con su saldo actual.</p></div>`}
    ${cerradas.length ? `<details class="seccion"><summary>Cuentas cerradas (${cerradas.length})</summary>
      <div class="rejilla rejilla-2" style="margin-top:var(--space-3)">${cerradas.map(tarjeta).join('')}</div></details>` : ''}
    <section class="seccion tarjeta" aria-labelledby="t-como"><h2 id="t-como">Cómo cuadrar las cuentas</h2>
      <p class="muted" style="margin-top:var(--space-2);max-width:70ch">Cada mes, abre el extracto del banco y pulsa «Cuadrar con el extracto»: escribe el saldo que pone el banco en una fecha y la app te dirá si coincide con lo apuntado. Para la caja, cuenta el efectivo y usa «Contar el efectivo». Si no cuadra, suele faltar algún apunte o haber un importe mal escrito.</p></section>`;

  $('#b-nueva-cuenta')?.addEventListener('click', () => formCuenta());
  $$('[data-editar-cuenta]').forEach(b => b.addEventListener('click', () => formCuenta(cuenta(b.dataset.editarCuenta))));
  $$('[data-cuadrar]').forEach(b => b.addEventListener('click', () => formCuadre(cuenta(b.dataset.cuadrar))));
}

function formCuenta(c = null) {
  const d = dialogo({
    titulo: c ? `Editar ${c.nombre}` : 'Añadir cuenta', cerrarFuera: false,
    cuerpo: `<form class="formulario" id="f-cta" novalidate>
      <fieldset class="campo" style="border:0;padding:0;margin:0"><legend class="etiqueta-campo" style="margin-bottom:var(--space-1)">Tipo</legend>
        <div class="segmentos">
          <input type="radio" name="ctipo" id="c-banco" value="banco" ${c?.tipo !== 'caja' ? 'checked' : ''}><label for="c-banco">${ico('banco', 'ico-s')} Banco</label>
          <input type="radio" name="ctipo" id="c-caja" value="caja" ${c?.tipo === 'caja' ? 'checked' : ''}><label for="c-caja">${ico('caja', 'ico-s')} Caja (efectivo)</label>
        </div></fieldset>
      <div class="campo"><label for="c-nombre">Nombre</label><input id="c-nombre" required maxlength="60" value="${esc(c?.nombre || '')}" placeholder="Ej.: Caja Rural" aria-describedby="c-nombre-err"><p class="error" id="c-nombre-err" hidden></p></div>
      <div class="campo"><label for="c-detalle">Detalle</label><input id="c-detalle" maxlength="80" value="${esc(c?.detalle || '')}" placeholder="Ej.: cuenta terminada en 1234" aria-describedby="c-detalle-ayuda">
        <p class="ayuda" id="c-detalle-ayuda">Opcional. No hace falta el número completo.</p></div>
      <div class="fila-campos">
        <div class="campo"><label for="c-saldo">Saldo inicial (€)</label><input id="c-saldo" inputmode="decimal" class="num" value="${c ? numInput(c.saldo_inicial) : ''}" placeholder="0,00" aria-describedby="c-saldo-err"><p class="error" id="c-saldo-err" hidden></p></div>
        <div class="campo"><label for="c-fecha">En fecha</label><input id="c-fecha" type="date" required value="${c?.fecha_inicial || hoy()}" aria-describedby="c-fecha-err"><p class="error" id="c-fecha-err" hidden></p></div>
      </div>
      <p class="ayuda">El saldo que tenía la cuenta ese día, según el banco o contando el efectivo. Los apuntes anteriores a esa fecha no cuentan para el saldo.</p>
      ${c ? `<label class="casilla"><input type="checkbox" id="c-activa" ${c.activa ? 'checked' : ''}> Cuenta en uso (desmárcala si se cierra)</label>` : ''}
      <div class="aviso aviso-error" id="c-error" role="alert" hidden></div>
    </form>`,
    pie: `<button type="button" class="btn" data-cerrar>Cancelar</button><button type="submit" form="f-cta" class="btn btn-primario">${c ? 'Guardar cambios' : 'Añadir cuenta'}</button>`,
  });
  const f = $('#f-cta', d);
  f.addEventListener('submit', async e => {
    e.preventDefault();
    const nombre = $('#c-nombre', f), saldo = $('#c-saldo', f), fec = $('#c-fecha', f);
    const s = saldo.value.trim() ? parseImporte(saldo.value) : 0;
    mostrarError(nombre, nombre.value.trim() ? '' : 'Pon un nombre para reconocer la cuenta.');
    mostrarError(saldo, Number.isNaN(s) ? 'Escribe el saldo con números, por ejemplo 1.250,00.' : '');
    mostrarError(fec, fec.value ? '' : 'Elige la fecha del saldo.');
    const malo = f.querySelector('[aria-invalid="true"]'); if (malo) return malo.focus();
    const datos = { nombre: nombre.value.trim(), tipo: $('input[name=ctipo]:checked', f).value, detalle: $('#c-detalle', f).value.trim() || null, saldo_inicial: s, fecha_inicial: fec.value };
    if (c) datos.activa = $('#c-activa', f).checked;
    await conBoton(d.querySelector('[type=submit]'), async () => {
      try {
        if (c) await q(sb.from('cuentas').update(datos).eq('id', c.id));
        else await q(sb.from('cuentas').insert({ ...datos, orden: E.cuentas.length }));
        d.close(); await refrescar(); tostada(c ? 'Cuenta actualizada' : 'Cuenta añadida');
      } catch (err) { const caja = $('#c-error', f); caja.innerHTML = `${ico('alerta')}<p>${esc(mensajeError(err))}</p>`; caja.hidden = false; }
    });
  });
}

function formCuadre(c) {
  const caja = c.tipo === 'caja';
  const d = dialogo({
    titulo: caja ? `Contar el efectivo · ${c.nombre}` : `Cuadrar ${c.nombre} con el extracto`, cerrarFuera: false,
    cuerpo: `<form class="formulario" id="f-cuadre" novalidate>
      <div class="fila-campos">
        <div class="campo"><label for="q-fecha">Fecha</label><input id="q-fecha" type="date" required value="${hoy()}"></div>
        <div class="campo"><label for="q-saldo">${caja ? 'Efectivo contado (€)' : 'Saldo del extracto (€)'}</label>
          <input id="q-saldo" inputmode="decimal" class="num" required placeholder="0,00" aria-describedby="q-saldo-err"><p class="error" id="q-saldo-err" hidden></p></div>
      </div>
      <div id="q-resultado" aria-live="polite"></div>
      <label class="casilla"><input type="checkbox" id="q-marcar"> Marcar como comprobados los apuntes de esta cuenta hasta esa fecha</label>
      <div class="campo"><label for="q-notas">Notas</label><textarea id="q-notas" maxlength="500" aria-describedby="q-notas-ayuda"></textarea><p class="ayuda" id="q-notas-ayuda">Opcional. Por ejemplo, qué explica la diferencia.</p></div>
      <div class="aviso aviso-error" id="q-error" role="alert" hidden></div>
    </form>`,
    pie: `<button type="button" class="btn" data-cerrar>Cancelar</button><button type="submit" form="f-cuadre" class="btn btn-primario">Guardar ${caja ? 'recuento' : 'cuadre'}</button>`,
  });
  const f = $('#f-cuadre', d), fec = $('#q-fecha', f), saldo = $('#q-saldo', f), res = $('#q-resultado', f), marcar = $('#q-marcar', f);
  let saldoApp = null;
  const calcular = async () => {
    const s = parseImporte(saldo.value);
    if (!fec.value) return;
    try { saldoApp = Number(await q(sb.rpc('saldo_a_fecha', { p_cuenta: c.id, p_fecha: fec.value }))); }
    catch (e) { res.innerHTML = `<p class="error">${esc(mensajeError(e))}</p>`; return; }
    if (Number.isNaN(s)) { res.innerHTML = `<p class="muted">Según lo apuntado, ese día había <strong class="num">${eur(saldoApp)}</strong>.</p>`; return; }
    const dif = Math.round((s - saldoApp) * 100) / 100;
    marcar.checked = dif === 0;
    res.innerHTML = dif === 0
      ? `<div class="aviso aviso-info">${ico('ok')}<p><strong>Cuadra.</strong> Lo apuntado coincide: ${eur(saldoApp)}.</p></div>`
      : `<div class="aviso aviso-aviso">${ico('alerta')}<p><strong>No cuadra.</strong> Según lo apuntado debería haber ${eur(saldoApp)}: ${dif > 0 ? 'sobran' : 'faltan'} <strong class="num">${eur(Math.abs(dif))}</strong>.
         Revisa si falta algún apunte (comisiones, ingresos…) o si hay un importe mal escrito.</p></div>`;
  };
  fec.addEventListener('change', calcular);
  saldo.addEventListener('blur', () => { const s = parseImporte(saldo.value); mostrarError(saldo, saldo.value.trim() && Number.isNaN(s) ? 'Escribe el saldo con números, por ejemplo 1.250,00.' : ''); if (!Number.isNaN(s)) saldo.value = numInput(s); calcular(); });
  calcular();
  f.addEventListener('submit', async e => {
    e.preventDefault();
    const s = parseImporte(saldo.value);
    mostrarError(saldo, Number.isNaN(s) ? (caja ? 'Escribe cuánto efectivo has contado.' : 'Escribe el saldo que aparece en el extracto.') : '');
    if (Number.isNaN(s)) return saldo.focus();
    await conBoton(d.querySelector('[type=submit]'), async () => {
      try {
        await calcular();
        await q(sb.from('conciliaciones').insert({ cuenta_id: c.id, fecha: fec.value, saldo_extracto: s, saldo_app: saldoApp, notas: $('#q-notas', f).value.trim() || null }));
        if (marcar.checked) {
          await q(sb.from('movimientos').update({ conciliado: true })
            .or(`cuenta_id.eq.${c.id},cuenta_destino_id.eq.${c.id}`).lte('fecha', fec.value).eq('anulado', false).eq('conciliado', false));
        }
        d.close(); await refrescar(); tostada(caja ? 'Recuento guardado' : 'Cuadre guardado');
      } catch (err) { const box = $('#q-error', f); box.innerHTML = `${ico('alerta')}<p>${esc(mensajeError(err))}</p>`; box.hidden = false; }
    });
  });
  saldo.focus();
}

// ======================================================================
// Ajustes
// ======================================================================
async function vistaAjustes() {
  const v = $('#vista');
  v.innerHTML = esqueleto(4);
  try { await cargarMaestros(); } catch (e) { return errorVista(v, e, vistaAjustes); }
  const a = E.ajustes || {};
  const ed = puedeEditar();
  const campoAj = (id, etiqueta, valor, extra = '') => `<div class="campo"><label for="aj-${id}">${etiqueta}</label>
    <input id="aj-${id}" value="${esc(valor || '')}" ${ed ? '' : 'readonly'} ${extra}></div>`;
  const listaCat = tipo => `<ul class="lista-simple">${E.categorias.filter(c => c.tipo === tipo).map(c => `<li>
      <span class="crece ${c.activa ? '' : 'muted'}">${esc(c.nombre)}${c.activa ? '' : ' <span class="etiqueta">Oculta</span>'}</span>
      ${ed ? `<button type="button" class="btn btn-texto" data-cat-renombrar="${c.id}">Renombrar</button>
        <button type="button" class="btn btn-texto" data-cat-activa="${c.id}">${c.activa ? 'Ocultar' : 'Mostrar'}</button>` : ''}</li>`).join('')}</ul>
      ${ed ? `<button type="button" class="btn btn-texto" data-cat-nueva="${tipo}" style="margin-top:var(--space-2)">${ico('mas', 'ico-s')} Añadir categoría de ${tipo === 'ingreso' ? 'ingresos' : 'gastos'}</button>` : ''}`;

  v.innerHTML = `
    <div class="encabezado-vista"><h1>Ajustes</h1><a class="btn" href="#historial">${ico('historial')} Historial de cambios</a></div>
    <div class="rejilla rejilla-2">
      <section class="tarjeta" aria-labelledby="t-yo"><h2 id="t-yo">Mi cuenta</h2>
        <dl class="datos" style="margin:var(--space-3) 0">
          <dt>Nombre</dt><dd>${esc(E.perfil.nombre)}</dd><dt>Correo</dt><dd>${esc(E.perfil.email)}</dd>
          <dt>Permiso</dt><dd>${ROLES[E.perfil.rol].nombre}<br><span class="muted pequeno">${ROLES[E.perfil.rol].desc}</span></dd></dl>
        <div style="display:flex;flex-wrap:wrap;gap:var(--space-2)">
          <button type="button" class="btn" id="b-nombre">${ico('lapiz')} Cambiar mi nombre</button>
          <button type="button" class="btn" id="b-pass">${ico('llave')} Cambiar mi contraseña</button>
          <button type="button" class="btn btn-texto" id="b-salir">${ico('salir')} Cerrar sesión</button></div>
      </section>
      <section class="tarjeta" aria-labelledby="t-copia"><h2 id="t-copia">Copias y descargas</h2>
        <p class="muted pequeno" style="margin:var(--space-2) 0 var(--space-3)">Descarga el libro para la gestoría o guarda una copia completa de los datos por seguridad.</p>
        <div style="display:flex;flex-wrap:wrap;gap:var(--space-2)">
          <button type="button" class="btn" id="b-libro-todo">${ico('descargar')} Libro completo (Excel)</button>
          ${esAdmin() ? `<button type="button" class="btn" id="b-copia">${ico('descargar')} Copia de seguridad</button>` : ''}</div>
      </section>
    </div>
    ${esAdmin() ? `<section class="seccion tarjeta" aria-labelledby="t-usu">
      <div class="encabezado-vista"><h2 id="t-usu">Personas con acceso</h2>
        <button type="button" class="btn btn-primario" id="b-nuevo-usu">${ico('mas')} Dar de alta</button></div>
      <ul class="lista-simple">${E.perfiles.map(p => `<li>
        ${ico('usuario', 'ico-s')}
        <span class="crece ${p.activo ? '' : 'muted'}"><strong>${esc(p.nombre)}</strong> ${p.id === E.perfil.id ? '<span class="etiqueta">Tú</span>' : ''}<br>
          <span class="muted pequeno">${esc(p.email)} · ${ROLES[p.rol].nombre}${p.activo ? '' : ' · Sin acceso'}</span></span>
        ${p.id === E.perfil.id ? '' : `<button type="button" class="btn btn-texto" data-usu="${p.id}">Gestionar</button>`}</li>`).join('')}</ul>
    </section>` : ''}
    <form class="seccion tarjeta formulario" id="f-ajustes" aria-labelledby="t-coral" novalidate>
      <h2 id="t-coral">Datos de la coral</h2>
      <p class="muted pequeno">Saldrán en facturas, presupuestos y recibos.</p>
      <div class="rejilla rejilla-2">
        ${campoAj('nombre', 'Nombre', a.nombre, 'required maxlength="120"')}
        ${campoAj('cif', 'CIF', a.cif, 'maxlength="15" autocomplete="off"')}
        ${campoAj('direccion', 'Dirección', a.direccion, 'maxlength="200" autocomplete="street-address"')}
        ${campoAj('email', 'Correo electrónico', a.email, 'type="email" maxlength="120"')}
        ${campoAj('telefono', 'Teléfono', a.telefono, 'type="tel" maxlength="20"')}
        ${campoAj('iban', 'IBAN para cobros', a.iban, 'maxlength="34" autocomplete="off"')}
        ${campoAj('localidad', 'Localidad (para los recibos)', a.localidad, 'maxlength="60" autocomplete="address-level2"')}
      </div>
      ${ed ? '<div><button type="submit" class="btn btn-primario">Guardar datos</button></div>' : ''}
    </form>
    ${seccionAjustesFacturas(a, ed)}
    ${esAdmin() ? seccionModoPruebas(a) : ''}
    <section class="seccion" aria-labelledby="t-cats"><h2 id="t-cats">Categorías</h2>
      <p class="muted pequeno" style="margin-bottom:var(--space-3)">Las categorías ocultas no aparecen al apuntar, pero los apuntes antiguos las conservan.</p>
      <div class="rejilla rejilla-2">
        <div class="tarjeta"><h3>Ingresos</h3>${listaCat('ingreso')}</div>
        <div class="tarjeta"><h3>Gastos</h3>${listaCat('gasto')}</div>
      </div></section>`;

  $('#b-salir').onclick = async () => { await sb.auth.signOut(); E.perfil = null; location.hash = ''; pantallaAcceso('Has cerrado la sesión.'); };
  $('#b-pass').onclick = formContrasena;
  $('#b-nombre').onclick = formMiNombre;
  $('#b-libro-todo').onclick = async e => conBoton(e.currentTarget, async () => {
    try {
      const todos = await q(sb.from('movimientos').select('*, justificantes(count)').order('ejercicio').order('numero').limit(50000));
      descargarLibro(todos.map(m => ({ ...m, njust: m.justificantes?.[0]?.count ?? 0 })), `libro-completo-${hoy()}.csv`);
    } catch (err) { tostada(mensajeError(err), { error: true }); }
  });
  $('#b-copia')?.addEventListener('click', e => conBoton(e.currentTarget, copiaSeguridad));
  $('#b-nuevo-usu')?.addEventListener('click', formUsuarioNuevo);
  $$('[data-usu]').forEach(b => b.addEventListener('click', () => gestionarUsuario(E.perfiles.find(p => p.id === b.dataset.usu))));
  $('#f-ajustes').addEventListener('submit', async e => {
    e.preventDefault();
    const datos = Object.fromEntries(['nombre', 'cif', 'direccion', 'email', 'telefono', 'iban', 'localidad'].map(k => [k, $('#aj-' + k).value.trim() || null]));
    if (!datos.nombre) { tostada('El nombre de la coral no puede quedar vacío.', { error: true }); return $('#aj-nombre').focus(); }
    await conBoton(e.submitter, async () => {
      try { await q(sb.from('ajustes').update({ ...datos, actualizado_en: new Date().toISOString() }).eq('id', 1)); tostada('Datos de la coral guardados'); }
      catch (err) { tostada(mensajeError(err), { error: true }); }
    });
  });
  conectarAjustesFacturas(a);
  $$('[data-borrar-pruebas]').forEach(b => b.addEventListener('click', () => borrarDatosPrueba(b.dataset.borrarPruebas === 'empezar')));
  $$('[data-cat-nueva]').forEach(b => b.addEventListener('click', () => formCategoria({ tipo: b.dataset.catNueva })));
  $$('[data-cat-renombrar]').forEach(b => b.addEventListener('click', () => formCategoria({ cat: categoria(b.dataset.catRenombrar) })));
  $$('[data-cat-activa]').forEach(b => b.addEventListener('click', async () => {
    const c = categoria(b.dataset.catActiva);
    try {
      await q(sb.from('categorias').update({ activa: !c.activa }).eq('id', c.id));
      await vistaAjustes();
      tostada(c.activa ? `«${c.nombre}» oculta` : `«${c.nombre}» visible de nuevo`, { deshacer: async () => { await q(sb.from('categorias').update({ activa: c.activa }).eq('id', c.id)); await vistaAjustes(); } });
    } catch (err) { tostada(mensajeError(err), { error: true }); }
  }));
}

function formCategoria({ tipo, cat }) {
  const d = dialogo({
    titulo: cat ? 'Renombrar categoría' : `Nueva categoría de ${tipo === 'ingreso' ? 'ingresos' : 'gastos'}`,
    cuerpo: `<form class="formulario" id="f-cat" novalidate><div class="campo"><label for="k-nombre">Nombre</label>
      <input id="k-nombre" required maxlength="60" value="${esc(cat?.nombre || '')}" aria-describedby="k-nombre-err"><p class="error" id="k-nombre-err" hidden></p></div></form>`,
    pie: `<button type="button" class="btn" data-cerrar>Cancelar</button><button type="submit" form="f-cat" class="btn btn-primario">${cat ? 'Guardar' : 'Añadir'}</button>`,
  });
  const inp = $('#k-nombre', d);
  $('#f-cat', d).addEventListener('submit', async e => {
    e.preventDefault();
    if (!inp.value.trim()) { mostrarError(inp, 'Escribe un nombre.'); return inp.focus(); }
    await conBoton(d.querySelector('[type=submit]'), async () => {
      try {
        if (cat) await q(sb.from('categorias').update({ nombre: inp.value.trim() }).eq('id', cat.id));
        else await q(sb.from('categorias').insert({ tipo, nombre: inp.value.trim(), orden: 50 }));
        d.close(); await vistaAjustes(); tostada(cat ? 'Categoría renombrada' : 'Categoría añadida');
      } catch (err) { mostrarError(inp, mensajeError(err)); }
    });
  });
  inp.focus();
}

function formContrasena() {
  const d = dialogo({
    titulo: 'Cambiar mi contraseña',
    cuerpo: `<form class="formulario" id="f-pass" novalidate>
      <input type="email" autocomplete="username" value="${esc(E.perfil.email)}" hidden>
      <div class="campo"><label for="w-1">Nueva contraseña</label><input id="w-1" type="password" autocomplete="new-password" minlength="8" required aria-describedby="w-1-ayuda w-1-err">
        <p class="ayuda" id="w-1-ayuda">Al menos 8 caracteres.</p><p class="error" id="w-1-err" hidden></p></div>
      <div class="campo"><label for="w-2">Repite la contraseña</label><input id="w-2" type="password" autocomplete="new-password" required aria-describedby="w-2-err"><p class="error" id="w-2-err" hidden></p></div>
    </form>`,
    pie: `<button type="button" class="btn" data-cerrar>Cancelar</button><button type="submit" form="f-pass" class="btn btn-primario">Cambiar contraseña</button>`,
  });
  $('#f-pass', d).addEventListener('submit', async e => {
    e.preventDefault();
    const a = $('#w-1', d), b = $('#w-2', d);
    mostrarError(a, a.value.length >= 8 ? '' : 'Debe tener al menos 8 caracteres.');
    mostrarError(b, a.value === b.value ? '' : 'Las dos contraseñas no coinciden.');
    if (a.value.length < 8) return a.focus();
    if (a.value !== b.value) return b.focus();
    await conBoton(d.querySelector('[type=submit]'), async () => {
      const { error } = await sb.auth.updateUser({ password: a.value });
      if (error) return mostrarError(b, /different|same/i.test(error.message) ? 'La nueva contraseña debe ser distinta de la actual.' : mensajeError(error));
      d.close(); tostada('Contraseña cambiada');
    });
  });
  $('#w-1', d).focus();
}

function radiosRol(nombre, actual) {
  return `<fieldset class="campo" style="border:0;padding:0;margin:0"><legend class="etiqueta-campo" style="margin-bottom:var(--space-1)">Permiso</legend>
    ${Object.entries(ROLES).map(([k, r]) => `<label class="casilla" style="align-items:flex-start;padding:var(--space-1) 0">
      <input type="radio" name="${nombre}" value="${k}" ${k === actual ? 'checked' : ''} style="margin-top:3px">
      <span><strong>${r.nombre}</strong><br><span class="muted pequeno">${r.desc}</span></span></label>`).join('')}</fieldset>`;
}

function mostrarCredenciales(titulo, nombre, email, password) {
  const url = location.href.split('#')[0];
  const texto = `Hola, ${nombre}. Ya tienes acceso a las cuentas de la coral.\n\nEntra en: ${url}\nCorreo: ${email}\nContraseña provisional: ${password}\n\nCuando entres, cámbiala en Ajustes → Cambiar mi contraseña.`;
  const d = dialogo({
    titulo,
    cuerpo: `<p style="margin-bottom:var(--space-3)">Envíale este mensaje a ${esc(nombre)} por WhatsApp o en persona. Es la única vez que verás la contraseña.</p>
      <textarea readonly rows="8" id="cred-texto" aria-label="Mensaje para enviar">${esc(texto)}</textarea>`,
    pie: `<button type="button" class="btn" data-cerrar>Cerrar</button><button type="button" class="btn btn-primario" id="b-copiar">${ico('copiar')} Copiar mensaje</button>`,
  });
  $('#b-copiar', d).onclick = async () => {
    try { await navigator.clipboard.writeText(texto); tostada('Mensaje copiado'); }
    catch { $('#cred-texto', d).select(); tostada('Selecciona el texto y cópialo a mano', { error: true }); }
  };
}

function formUsuarioNuevo() {
  const pass = contrasenaProvisional();
  const d = dialogo({
    titulo: 'Dar de alta a una persona', cerrarFuera: false,
    cuerpo: `<form class="formulario" id="f-usu" novalidate>
      <div class="campo"><label for="u-nombre">Nombre</label><input id="u-nombre" required maxlength="80" autocomplete="off" aria-describedby="u-nombre-err"><p class="error" id="u-nombre-err" hidden></p></div>
      <div class="campo"><label for="u-email">Correo electrónico</label><input id="u-email" type="email" required autocomplete="off" aria-describedby="u-email-ayuda u-email-err">
        <p class="ayuda" id="u-email-ayuda">Con él entrará en la app. No se le envía ningún correo.</p><p class="error" id="u-email-err" hidden></p></div>
      ${radiosRol('u-rol', 'junta')}
      <div class="campo"><label for="u-pass">Contraseña provisional</label><input id="u-pass" value="${pass}" autocomplete="off" class="num" minlength="8" required aria-describedby="u-pass-ayuda u-pass-err">
        <p class="ayuda" id="u-pass-ayuda">La podrá cambiar después desde Ajustes.</p><p class="error" id="u-pass-err" hidden></p></div>
      <div class="aviso aviso-error" id="u-error" role="alert" hidden></div>
    </form>`,
    pie: `<button type="button" class="btn" data-cerrar>Cancelar</button><button type="submit" form="f-usu" class="btn btn-primario">Dar de alta</button>`,
  });
  const f = $('#f-usu', d);
  f.addEventListener('submit', async e => {
    e.preventDefault();
    const nombre = $('#u-nombre', f), email = $('#u-email', f), p = $('#u-pass', f);
    mostrarError(nombre, nombre.value.trim() ? '' : 'Escribe su nombre.');
    mostrarError(email, email.value && email.validity.valid ? '' : 'Escribe un correo válido.');
    mostrarError(p, p.value.length >= 8 ? '' : 'Al menos 8 caracteres.');
    const malo = f.querySelector('[aria-invalid="true"]'); if (malo) return malo.focus();
    await conBoton(d.querySelector('[type=submit]'), async () => {
      try {
        await llamarUsuarios({ accion: 'crear', nombre: nombre.value.trim(), email: email.value.trim(), rol: $('input[name="u-rol"]:checked', f).value, password: p.value });
        d.close(); await vistaAjustes();
        mostrarCredenciales('Alta hecha', nombre.value.trim(), email.value.trim().toLowerCase(), p.value);
      } catch (err) { const box = $('#u-error', f); box.innerHTML = `${ico('alerta')}<p>${esc(mensajeError(err))}</p>`; box.hidden = false; }
    });
  });
  $('#u-nombre', f).focus();
}

function formMiNombre() {
  const d = dialogo({
    titulo: 'Cambiar mi nombre',
    cuerpo: `<form class="formulario" id="f-minombre" novalidate>
      <div class="campo"><label for="n-nombre">Nombre y apellidos</label>
        <input id="n-nombre" required maxlength="80" autocomplete="name" value="${esc(E.perfil.nombre)}" aria-describedby="n-nombre-ayuda n-nombre-err">
        <p class="ayuda" id="n-nombre-ayuda">Así aparecerás en el historial, en los recibos que firmes y en la memoria anual.</p>
        <p class="error" id="n-nombre-err" hidden></p></div></form>`,
    pie: `<button type="button" class="btn" data-cerrar>Cancelar</button><button type="submit" form="f-minombre" class="btn btn-primario">Guardar nombre</button>`,
  });
  const inp = $('#n-nombre', d);
  $('#f-minombre', d).addEventListener('submit', async e => {
    e.preventDefault();
    const nombre = inp.value.trim();
    mostrarError(inp, nombre ? '' : 'Escribe tu nombre.');
    if (!nombre) return inp.focus();
    await conBoton(d.querySelector('[type=submit]'), async () => {
      try {
        await q(sb.rpc('cambiar_mi_nombre', { p_nombre: nombre }));
        E.perfil.nombre = nombre; d.close(); await vistaAjustes(); tostada('Nombre cambiado');
      } catch (err) { mostrarError(inp, mensajeError(err)); }
    });
  });
  inp.focus(); inp.select();
}

function gestionarUsuario(p) {
  const d = dialogo({
    titulo: p.nombre,
    cuerpo: `<form class="formulario" id="f-gest" novalidate>
      <p class="muted">${esc(p.email)}</p>
      <div class="campo"><label for="g-nombre">Nombre y apellidos</label>
        <input id="g-nombre" required maxlength="80" autocomplete="off" value="${esc(p.nombre)}" aria-describedby="g-nombre-err"><p class="error" id="g-nombre-err" hidden></p></div>
      ${radiosRol('g-rol', p.rol)}
      <div class="aviso aviso-error" id="g-error" role="alert" hidden></div>
    </form>`,
    pie: `<button type="button" class="btn btn-texto izquierda" id="g-activo">${p.activo ? 'Quitar el acceso' : 'Devolver el acceso'}</button>
      <button type="button" class="btn" id="g-pass">${ico('llave')} Nueva contraseña</button>
      <button type="submit" form="f-gest" class="btn btn-primario">Guardar cambios</button>`,
  });
  const err = x => { const box = $('#g-error', d); box.innerHTML = `${ico('alerta')}<p>${esc(mensajeError(x))}</p>`; box.hidden = false; };
  $('#f-gest', d).addEventListener('submit', async e => {
    e.preventDefault();
    const rol = $('input[name="g-rol"]:checked', d).value, nom = $('#g-nombre', d), nombre = nom.value.trim();
    mostrarError(nom, nombre ? '' : 'Escribe su nombre.');
    if (!nombre) return nom.focus();
    await conBoton(d.querySelector('[type=submit]'), async () => {
      try {
        await llamarUsuarios({ accion: 'cambiar', id: p.id, rol, nombre });
        d.close(); await vistaAjustes();
        tostada(rol !== p.rol ? `${nombre} ahora es ${ROLES[rol].nombre.toLowerCase()}` : 'Cambios guardados');
      } catch (x) { err(x); }
    });
  });
  $('#g-activo', d).onclick = async () => {
    if (p.activo) {
      const r = await confirmar({ titulo: `¿Quitar el acceso a ${esc(p.nombre)}?`, texto: 'No podrá entrar ni ver las cuentas. Lo que haya apuntado se queda en el libro. Puedes devolverle el acceso cuando quieras.', boton: 'Quitar el acceso', peligro: true });
      if (!r) return;
    }
    try { await llamarUsuarios({ accion: 'cambiar', id: p.id, activo: !p.activo }); d.close(); await vistaAjustes(); tostada(p.activo ? `${p.nombre} ya no tiene acceso` : `${p.nombre} vuelve a tener acceso`); }
    catch (x) { err(x); }
  };
  $('#g-pass', d).onclick = async () => {
    const r = await confirmar({ titulo: `¿Poner una contraseña nueva a ${esc(p.nombre)}?`, texto: 'La actual dejará de funcionar. Te mostraré la nueva para que se la envíes.', boton: 'Generar contraseña' });
    if (!r) return;
    const nueva = contrasenaProvisional();
    try { await llamarUsuarios({ accion: 'restablecer', id: p.id, password: nueva }); d.close(); mostrarCredenciales('Contraseña nueva', p.nombre, p.email, nueva); }
    catch (x) { err(x); }
  };
}

async function copiaSeguridad() {
  try {
    const tablas = ['ajustes', 'cuentas', 'categorias', 'movimientos', 'justificantes', 'conciliaciones', 'clientes', 'documentos', 'recibos', 'subvenciones', 'subvencion_gastos', 'subvencion_documentos', 'memorias', 'presupuesto_lineas', 'perfiles', 'historial'];
    const datos = {};
    for (const t of tablas) datos[t] = await q(sb.from(t).select('*').limit(100000));
    descargar(`copia-cuentas-coral-${hoy()}.json`, JSON.stringify({ fecha: new Date().toISOString(), version: 1, datos }, null, 1), 'application/json');
    tostada('Copia descargada. Guárdala en un sitio seguro: contiene datos personales.');
  } catch (e) { tostada(mensajeError(e), { error: true }); }
}

// ======================================================================
// Historial de cambios
// ======================================================================
const CAMPOS = { fecha: 'fecha', tipo: 'tipo', concepto: 'concepto', tercero: 'persona', categoria_id: 'categoría', cuenta_id: 'cuenta',
  cuenta_destino_id: 'cuenta destino', importe: 'importe', notas: 'notas', conciliado: 'comprobado', anulado: 'anulado',
  nombre: 'nombre', detalle: 'detalle', saldo_inicial: 'saldo inicial', fecha_inicial: 'fecha del saldo', activa: 'en uso', rol: 'permiso', activo: 'acceso',
  subvencion_id: 'subvención' };
function valorLegible(k, v) {
  if (k === 'subvencion_id') return v ? 'enlazada' : 'ninguna';
  if (v === null || v === undefined || v === '') return '—';
  if (k === 'importe' || k === 'saldo_inicial') return eur(v);
  if (k === 'categoria_id') return categoria(v)?.nombre || '?';
  if (k === 'cuenta_id' || k === 'cuenta_destino_id') return cuenta(v)?.nombre || '?';
  if (k === 'fecha' || k === 'fecha_inicial') return fecha(v);
  if (typeof v === 'boolean') return v ? 'sí' : 'no';
  if (k === 'tipo') return TIPOS[v] || v;
  if (k === 'rol') return ROLES[v]?.nombre || v;
  return String(v);
}
function describir(h) {
  const d = h.despues || {}, a = h.antes || {};
  const ap = x => `apunte nº ${x.numero}/${x.ejercicio}`;
  if (h.tabla === 'movimientos') {
    if (h.accion === 'alta') return `Apuntó el ${ap(d)}: ${d.concepto} (${eur(d.importe)})`;
    if (a.anulado !== d.anulado) return d.anulado ? `Anuló el ${ap(d)}: ${d.motivo_anulacion || ''}` : `Reactivó el ${ap(d)}`;
    const cambios = Object.keys(CAMPOS).filter(k => k in d && JSON.stringify(a[k]) !== JSON.stringify(d[k]));
    if (cambios.length === 1 && cambios[0] === 'conciliado') return `Marcó como comprobado el ${ap(d)}`;
    return `Cambió el ${ap(d)}: ` + cambios.map(k => `${CAMPOS[k]} ${valorLegible(k, a[k])} → ${valorLegible(k, d[k])}`).join('; ');
  }
  if (h.tabla === 'justificantes') return h.accion === 'alta' ? `Añadió el justificante «${d.nombre}»` : `Quitó el justificante «${a.nombre}»`;
  if (h.tabla === 'conciliaciones') return `Cuadró ${cuenta(d.cuenta_id)?.nombre || 'una cuenta'} a ${fecha(d.fecha)}: real ${eur(d.saldo_extracto)}, apuntado ${eur(d.saldo_app)}`;
  if (h.tabla === 'ajustes') return 'Cambió los ajustes de la coral';
  if (h.tabla === 'documentos') return describirDocumento(h);
  if (h.tabla === 'subvenciones') {
    const x = h.despues || h.antes || {};
    if (h.accion === 'alta') return `Añadió la subvención «${x.convocatoria}» (${x.organismo})`;
    if (h.accion === 'baja') return `Borró la subvención «${x.convocatoria}»`;
    if (h.antes?.estado !== h.despues?.estado) return `Subvención «${x.convocatoria}»: ${ESTADOS_SUB[h.antes.estado][0].toLowerCase()} → ${ESTADOS_SUB[x.estado][0].toLowerCase()}`;
    return `Modificó la subvención «${x.convocatoria}»`;
  }
  if (h.tabla === 'subvencion_gastos') return h.accion === 'baja' ? `Quitó un gasto de ${eur(h.antes.importe)} de una subvención` : `Asignó un gasto de ${eur((h.despues || {}).importe)} a una subvención`;
  if (h.tabla === 'subvencion_documentos') return h.accion === 'baja' ? `Quitó el documento «${h.antes.nombre}» de una subvención` : `Añadió el documento «${h.despues.nombre}» a una subvención`;
  if (h.tabla === 'recibos') {
    const x = h.despues || h.antes || {};
    if (h.accion === 'alta') return `Hizo el recibo ${x.codigo} (${x.tipo === 'pago' ? 'pago a' : 'cobro de'} ${x.persona}, ${eur(x.importe)})`;
    if (h.antes && !h.antes.anulado && x.anulado) return `Anuló el recibo ${x.codigo}: ${x.motivo_anulacion || ''}`;
    return `Completó el recibo ${x.codigo}`;
  }
  const nombre = d.nombre || a.nombre || '';
  const que = { cuentas: 'la cuenta', categorias: 'la categoría', perfiles: 'el usuario', clientes: 'el cliente' }[h.tabla] || h.tabla;
  if (h.accion === 'alta') return `Creó ${que} «${nombre}»`;
  if (h.accion === 'baja') return `Borró ${que} «${nombre}»`;
  const cambios = Object.keys(CAMPOS).filter(k => k in d && JSON.stringify(a[k]) !== JSON.stringify(d[k]));
  return `Cambió ${que} «${nombre}»: ` + cambios.map(k => `${CAMPOS[k]} ${valorLegible(k, a[k])} → ${valorLegible(k, d[k])}`).join('; ');
}

async function vistaHistorial() {
  const v = $('#vista');
  v.innerHTML = esqueleto(6);
  let filas;
  try { filas = await q(sb.from('historial').select('*').order('en', { ascending: false }).limit(300)); }
  catch (e) { return errorVista(v, e, vistaHistorial); }
  v.innerHTML = `
    <div class="encabezado-vista"><a class="btn btn-texto" href="#ajustes">← Ajustes</a></div>
    <div class="encabezado-vista"><h1>Historial de cambios</h1></div>
    <p class="muted" style="margin-bottom:var(--space-4);max-width:70ch">Todo lo que se apunta, corrige o anula queda registrado aquí con quién y cuándo. Se muestran los últimos 300 cambios.</p>
    ${filas.length ? `<ul class="lista-apuntes">${filas.map(h => {
      const deshacible = puedeEditar() && h.tabla === 'movimientos' && h.accion === 'cambio';
      return `<li style="display:flex;gap:var(--space-3);align-items:center;padding:var(--space-3) var(--space-4)">
        <div style="margin-right:auto;min-width:0"><p style="overflow-wrap:anywhere">${esc(describir(h))}</p>
          <p class="muted pequeno">${esc(h.usuario_nombre || 'Sistema')} · ${fechaHora(h.en)}</p></div>
        ${deshacible ? `<button type="button" class="btn btn-texto" data-deshacer="${h.id}">${ico('deshacer', 'ico-s')} Deshacer</button>` : ''}</li>`;
    }).join('')}</ul>` : `<div class="vacio">${ico('historial')}<h2>Aún no hay cambios</h2><p>Cuando alguien apunte o corrija algo, quedará registrado aquí.</p></div>`}`;
  $$('[data-deshacer]').forEach(b => b.addEventListener('click', async () => {
    const h = filas.find(x => String(x.id) === b.dataset.deshacer);
    const r = await confirmar({ titulo: '¿Deshacer este cambio?', texto: `El apunte volverá a como estaba antes:<br><em>${esc(describir(h))}</em>`, boton: 'Deshacer cambio' });
    if (!r) return;
    const campos = ['fecha', 'tipo', 'concepto', 'tercero', 'categoria_id', 'cuenta_id', 'cuenta_destino_id', 'importe', 'notas', 'conciliado', 'anulado', 'motivo_anulacion'];
    try {
      await q(sb.from('movimientos').update(Object.fromEntries(campos.map(k => [k, h.antes[k]]))).eq('id', h.registro_id));
      tostada('Cambio deshecho'); vistaHistorial();
    } catch (e) { tostada(mensajeError(e), { error: true }); }
  }));
}

// ======================================================================
// Arranque
// ======================================================================
// ======================================================================
// Presupuestos y facturas (tanda 2)
// ======================================================================
const TIPO_DOC = { presupuesto: 'Presupuesto', factura: 'Factura', rectificativa: 'Factura rectificativa' };
const ESTADOS_DOC = {
  borrador: ['Borrador', ''], enviado: ['Enviado', ''], aceptado: ['Aceptado', 'etiqueta-ok'], rechazado: ['Rechazado', 'etiqueta-error'],
  facturado: ['Facturado', 'etiqueta-ok'], emitida: ['Pendiente de cobro', 'etiqueta-aviso'], cobrada: ['Cobrada', 'etiqueta-ok'],
  rectificada: ['Rectificada', 'etiqueta-error'],
};
const IVAS = [[0, 'Exenta de IVA (0 %)'], [10, '10 %'], [21, '21 %']];
const numCorto = n => Number(n).toLocaleString('es-ES', { maximumFractionDigits: 2, useGrouping: false });
const redondear = n => Math.round(n * 100) / 100;
const sumarDias = (iso, dias) => { const d = new Date(iso + 'T12:00:00'); d.setDate(d.getDate() + Number(dias)); return d.toISOString().slice(0, 10); };
const caducado = d => d.tipo === 'presupuesto' && ['borrador', 'enviado'].includes(d.estado) && d.validez_hasta && d.validez_hasta < hoy();
const estadoTexto = d => (ESTADOS_DOC[d.estado]?.[0] || d.estado || '').toLowerCase();
const articulo = tipo => (tipo === 'presupuesto' ? 'el' : 'la');
function chipEstado(d) {
  if (d.tipo === 'rectificativa') return '<span class="etiqueta">Rectificativa</span>';
  if (caducado(d)) return '<span class="etiqueta etiqueta-aviso">Caducado</span>';
  const [t, c] = ESTADOS_DOC[d.estado] || [d.estado, ''];
  return `<span class="etiqueta ${c}">${t}</span>`;
}
const resumenLineas = d => { const c = d.lineas?.[0]?.concepto || ''; return d.lineas?.length > 1 ? `${c} y ${d.lineas.length - 1} más` : c; };
function describirDocumento(h) {
  const a = h.antes || {}, d = h.despues || {}, x = h.accion === 'baja' ? a : d;
  const nombre = `${articulo(x.tipo)} ${(TIPO_DOC[x.tipo] || 'documento').toLowerCase()} ${x.codigo}`;
  if (h.accion === 'alta') return `Creó ${nombre} para ${x.cliente?.nombre || '—'} (${eur(x.total)})`;
  if (h.accion === 'baja') return `Borró ${nombre}`;
  if (a.estado !== d.estado) return `${x.codigo}: ${estadoTexto(a)} → ${estadoTexto(d)}`;
  return `Modificó ${nombre}`;
}
function irA(ruta) { if (location.hash === '#' + ruta) enrutar(); else location.hash = ruta; }

async function vistaFacturas(params) {
  const v = $('#vista');
  const ver = ['presupuestos', 'facturas', 'recibos', 'clientes'].includes(params.get('ver')) ? params.get('ver') : 'presupuestos';
  v.innerHTML = esqueleto(4);
  let docs, clientes, recibos;
  try {
    [docs, clientes, recibos] = await Promise.all([
      q(sb.from('documentos').select('*').eq('ejercicio', E.ejercicio).order('fecha', { ascending: false }).order('numero', { ascending: false })),
      q(sb.from('clientes').select('*').order('nombre')),
      q(sb.from('recibos').select('*').eq('ejercicio', E.ejercicio).order('numero', { ascending: false })),
    ]);
  } catch (e) { return errorVista(v, e, () => vistaFacturas(params)); }
  E.docs = docs; E.clientes = clientes;
  const pres = docs.filter(d => d.tipo === 'presupuesto'), facs = docs.filter(d => d.tipo !== 'presupuesto');
  const pestana = (k, txt, n) => `<a href="#facturas?ver=${k}" ${ver === k ? 'aria-current="page"' : ''}>${txt} <span class="contador">${n}</span></a>`;
  const filaDoc = d => `<li><button type="button" class="fila" data-doc="${d.id}">
    <span class="concepto">${esc(d.cliente?.nombre || '')}</span>
    <span class="importe num ${Number(d.total) < 0 ? 'negativo' : ''}">${eur(d.total)}</span>
    <span class="meta"><span class="num">${esc(d.codigo)}</span><span>${fecha(d.fecha)}</span>
      ${resumenLineas(d) ? `<span>${esc(resumenLineas(d))}</span>` : ''}${chipEstado(d)}</span></button></li>`;
  const vacio = (icono, titulo, texto, boton) => `<div class="vacio">${ico(icono)}<h2>${titulo}</h2><p>${texto}</p>${boton || ''}</div>`;

  let contenido;
  if (ver === 'presupuestos') {
    contenido = pres.length ? `<ul class="lista-apuntes">${pres.map(filaDoc).join('')}</ul>`
      : vacio('archivo', `Aún no hay presupuestos en ${E.ejercicio}`, 'Prepara un presupuesto para una boda o un evento. Si lo aceptan, se convierte en factura con un botón.',
        puedeEditar() ? `<button type="button" class="btn btn-primario" data-doc-nuevo="presupuesto">${ico('mas')} Hacer el primero</button>` : '');
  } else if (ver === 'facturas') {
    const pend = facs.filter(d => d.tipo === 'factura' && d.estado === 'emitida');
    const facturado = facs.filter(d => d.estado !== 'rectificada' && d.tipo === 'factura').reduce((s, d) => s + Number(d.total), 0);
    contenido = facs.length ? `
      <div class="resumen-libro"><span>Facturado <strong class="num">${eur(facturado)}</strong></span>
        <span>Pendiente de cobro <strong class="num">${eur(pend.reduce((s, d) => s + Number(d.total), 0))}</strong> (${pend.length})</span>
        <button type="button" class="btn btn-texto" id="b-csv-fact">${ico('descargar', 'ico-s')} Listado para la gestoría</button></div>
      <ul class="lista-apuntes">${facs.map(filaDoc).join('')}</ul>`
      : vacio('factura', `Aún no hay facturas en ${E.ejercicio}`, 'Las facturas se crean directamente o a partir de un presupuesto aceptado. Se numeran solas y en orden.',
        puedeEditar() ? `<button type="button" class="btn btn-primario" data-doc-nuevo="factura">${ico('mas')} Nueva factura</button>` : '');
  } else if (ver === 'recibos') {
    contenido = `${puedeEditar() && recibos.length ? `<div class="encabezado-vista"><span></span><button type="button" class="btn btn-primario" data-recibo-nuevo>${ico('lapiz')} Nuevo recibo firmado</button></div>` : ''}
      ${recibos.length ? `<ul class="lista-apuntes">${recibos.map(r => `<li><button type="button" class="fila ${r.anulado ? 'anulada' : ''}" data-recibo="${r.id}">
          <span class="concepto">${esc(r.persona)}</span>
          <span class="importe num ${r.tipo === 'pago' ? 'negativo' : 'positivo'}"><span class="sr">${r.tipo === 'pago' ? 'Pago' : 'Cobro'} de </span>${r.tipo === 'pago' ? '−' : '+'}${eur(r.importe)}</span>
          <span class="meta"><span class="num">${esc(r.codigo)}</span><span>${fecha(r.fecha)}</span><span>${esc(r.concepto)}</span>
            <span class="etiqueta">${r.tipo === 'pago' ? 'Pago' : 'Cobro'}</span>${r.anulado ? '<span class="etiqueta etiqueta-error">Anulado</span>' : ''}</span>
        </button></li>`).join('')}</ul>`
      : vacio('lapiz', `Aún no hay recibos en ${E.ejercicio}`, 'Cuando la coral pague o cobre en mano, haz el recibo en el móvil y que la otra persona firme con el dedo. Se apunta solo en el libro.',
        puedeEditar() ? `<button type="button" class="btn btn-primario" data-recibo-nuevo>${ico('lapiz')} Hacer el primero</button>` : '')}`;
  } else {
    contenido = `${puedeEditar() ? `<div class="encabezado-vista"><span></span><button type="button" class="btn" id="b-cli-nuevo">${ico('mas')} Añadir cliente</button></div>` : ''}
      ${clientes.length ? `<ul class="lista-apuntes">${clientes.map(c => `<li><button type="button" class="fila" data-cliente="${c.id}">
          <span class="concepto">${esc(c.nombre)}</span><span></span>
          <span class="meta">${[c.nif, c.telefono, c.email].filter(Boolean).map(x => `<span>${esc(x)}</span>`).join('') || '<span>Sin datos de contacto</span>'}</span>
        </button></li>`).join('')}</ul>`
      : vacio('usuario', 'No hay clientes guardados', 'Se guardan solos al hacer un presupuesto o una factura, para no tener que escribir sus datos otra vez.')}`;
  }

  v.innerHTML = `
    <div class="encabezado-vista"><h1>Presupuestos y facturas ${E.ejercicio}</h1>
      ${puedeEditar() ? `<button type="button" class="btn" data-doc-nuevo="factura">${ico('mas')} Nueva factura</button>
        <button type="button" class="btn btn-primario" data-doc-nuevo="presupuesto">${ico('mas')} Nuevo presupuesto</button>` : ''}</div>
    <nav class="subpestanas" aria-label="Tipo de documento">
      ${pestana('presupuestos', 'Presupuestos', pres.length)}${pestana('facturas', 'Facturas', facs.length)}${pestana('recibos', 'Recibos', recibos.length)}${pestana('clientes', 'Clientes', clientes.length)}</nav>
    ${contenido}`;
  $$('[data-recibo-nuevo]', v).forEach(b => b.addEventListener('click', () => formRecibo()));
  $$('[data-recibo]', v).forEach(b => b.addEventListener('click', () => abrirRecibo(b.dataset.recibo)));
  $$('[data-doc-nuevo]', v).forEach(b => b.addEventListener('click', () => formDocumento({ tipo: b.dataset.docNuevo })));
  $$('[data-doc]', v).forEach(b => b.addEventListener('click', () => abrirDocumento(b.dataset.doc)));
  $$('[data-cliente]', v).forEach(b => b.addEventListener('click', () => formCliente(clientes.find(c => c.id === b.dataset.cliente))));
  $('#b-cli-nuevo')?.addEventListener('click', () => formCliente());
  $('#b-csv-fact')?.addEventListener('click', () => {
    const filas = [...facs].sort((a, b) => a.tipo.localeCompare(b.tipo) || a.numero - b.numero).map(d => [
      d.codigo, d.fecha.split('-').reverse().join('/'), TIPO_DOC[d.tipo], d.cliente?.nombre || '', d.cliente?.nif || '',
      csvNum(d.base), numCorto(d.iva_pct), csvNum(d.iva_importe), csvNum(d.total), ESTADOS_DOC[d.estado]?.[0] || d.estado,
      d.cobrada_en ? d.cobrada_en.split('-').reverse().join('/') : '']);
    descargar(`facturas-${E.ejercicio}.csv`, csv([['Número', 'Fecha', 'Tipo', 'Cliente', 'NIF', 'Base', 'IVA %', 'IVA', 'Total', 'Estado', 'Cobrada el'], ...filas]), 'text/csv;charset=utf-8');
  });
}

function formCliente(c = null) {
  const campo = (id, et, val, extra = '') => `<div class="campo"><label for="k-${id}">${et}</label><input id="k-${id}" value="${esc(val || '')}" ${puedeEditar() ? '' : 'readonly'} ${extra}></div>`;
  const d = dialogo({
    titulo: c ? c.nombre : 'Añadir cliente', cerrarFuera: !puedeEditar(),
    cuerpo: `<form class="formulario" id="f-cli" novalidate>
      <div class="campo"><label for="k-nombre">Nombre o razón social</label><input id="k-nombre" required maxlength="150" value="${esc(c?.nombre || '')}" ${puedeEditar() ? '' : 'readonly'} aria-describedby="k-nombre-err"><p class="error" id="k-nombre-err" hidden></p></div>
      <div class="fila-campos">${campo('nif', 'NIF / CIF', c?.nif, 'maxlength="20" autocomplete="off"')}${campo('telefono', 'Teléfono', c?.telefono, 'type="tel" maxlength="20"')}</div>
      ${campo('direccion', 'Dirección', c?.direccion, 'maxlength="200"')}
      ${campo('email', 'Correo electrónico', c?.email, 'type="email" maxlength="120"')}
      <div class="campo"><label for="k-notas">Notas internas</label><textarea id="k-notas" maxlength="500" ${puedeEditar() ? '' : 'readonly'}>${esc(c?.notas || '')}</textarea></div>
      <p class="ayuda">Cambiar estos datos no modifica las facturas ya emitidas, que conservan los datos que tenían.</p>
      <div class="aviso aviso-error" id="k-error" role="alert" hidden></div></form>`,
    pie: puedeEditar() ? `<button type="button" class="btn" data-cerrar>Cancelar</button><button type="submit" form="f-cli" class="btn btn-primario">${c ? 'Guardar cambios' : 'Añadir cliente'}</button>`
      : '<button type="button" class="btn" data-cerrar>Cerrar</button>',
  });
  $('#f-cli', d).addEventListener('submit', async e => {
    e.preventDefault();
    const nom = $('#k-nombre', d);
    mostrarError(nom, nom.value.trim() ? '' : 'Escribe el nombre.');
    if (!nom.value.trim()) return nom.focus();
    const datos = Object.fromEntries(['nombre', 'nif', 'direccion', 'email', 'telefono', 'notas'].map(k => [k, $('#k-' + k, d).value.trim() || null]));
    await conBoton(d.querySelector('[type=submit]'), async () => {
      try {
        if (c) await q(sb.from('clientes').update(datos).eq('id', c.id)); else await q(sb.from('clientes').insert(datos));
        d.close(); irA('facturas?ver=clientes'); tostada(c ? 'Cliente actualizado' : 'Cliente añadido');
      } catch (err) { const box = $('#k-error', d); box.innerHTML = `${ico('alerta')}<p>${esc(mensajeError(err))}</p>`; box.hidden = false; }
    });
  });
}

// Guarda o actualiza el cliente al hacer un documento; devuelve su id
async function guardarCliente(cli) {
  const existente = (E.clientes || []).find(c => c.nombre.trim().toLowerCase() === cli.nombre.toLowerCase());
  if (existente) {
    const cambios = Object.fromEntries(['nif', 'direccion', 'email', 'telefono'].filter(k => cli[k] && cli[k] !== existente[k]).map(k => [k, cli[k]]));
    if (Object.keys(cambios).length) await q(sb.from('clientes').update(cambios).eq('id', existente.id));
    return existente.id;
  }
  const nuevo = await q(sb.from('clientes').insert(cli).select('id').single());
  return nuevo.id;
}

function formDocumento({ tipo, doc = null, base = null }) {
  const src = doc || base;
  const aj = E.ajustes || {};
  const conceptos = [...new Set([...(aj.conceptos_frecuentes || '').split('\n').map(s => s.trim()).filter(Boolean),
    ...(E.docs || []).flatMap(x => x.lineas.map(l => l.concepto))])].slice(0, 100);
  const lineas0 = src?.lineas?.map(l => ({ ...l, cantidad: Math.abs(l.cantidad) })) || [{ concepto: '', cantidad: 1, precio: '' }];
  const iva0 = Number(src?.iva_pct ?? aj.iva_pct ?? 0);
  const fecha0 = doc?.fecha || hoy();
  const cli = src?.cliente || {};
  const d = dialogo({
    titulo: doc ? `Editar ${doc.codigo}` : tipo === 'presupuesto' ? 'Nuevo presupuesto' : 'Nueva factura', cerrarFuera: false,
    cuerpo: `<form class="formulario" id="f-doc" novalidate>
      <fieldset class="grupo"><legend>Cliente</legend>
        <div class="campo"><label for="d-cli">Nombre o razón social</label>
          <input id="d-cli" list="dl-clientes" required maxlength="150" autocomplete="off" value="${esc(cli.nombre || '')}" aria-describedby="d-cli-ayuda d-cli-err">
          <datalist id="dl-clientes">${(E.clientes || []).map(c => `<option value="${esc(c.nombre)}"></option>`).join('')}</datalist>
          <p class="ayuda" id="d-cli-ayuda">Si ya está guardado, elígelo de la lista y se rellenan sus datos.</p><p class="error" id="d-cli-err" hidden></p></div>
        <details id="d-cli-datos" ${cli.nif || cli.direccion ? 'open' : ''}><summary>NIF, dirección y contacto</summary>
          <div class="formulario detalles-cliente">
            <div class="fila-campos"><div class="campo"><label for="d-nif">NIF / CIF</label><input id="d-nif" maxlength="20" autocomplete="off" value="${esc(cli.nif || '')}"></div>
              <div class="campo"><label for="d-tel">Teléfono</label><input id="d-tel" type="tel" maxlength="20" value="${esc(cli.telefono || '')}"></div></div>
            <div class="campo"><label for="d-dir">Dirección</label><input id="d-dir" maxlength="200" value="${esc(cli.direccion || '')}"></div>
            <div class="campo"><label for="d-email">Correo electrónico</label><input id="d-email" type="email" maxlength="120" value="${esc(cli.email || '')}"></div>
          </div></details>
      </fieldset>
      <div class="fila-campos">
        <div class="campo"><label for="d-fecha">Fecha</label><input id="d-fecha" type="date" required value="${fecha0}"></div>
        ${tipo === 'presupuesto' ? `<div class="campo"><label for="d-validez">Válido hasta</label><input id="d-validez" type="date" value="${doc?.validez_hasta || sumarDias(fecha0, aj.validez_dias || 30)}"></div>` : ''}
      </div>
      <fieldset class="grupo"><legend>Conceptos</legend>
        <datalist id="dl-conceptos-doc">${conceptos.map(c => `<option value="${esc(c)}"></option>`).join('')}</datalist>
        <ol class="lineas" id="d-lineas"></ol>
        <p class="error" id="d-lineas-err" role="alert" hidden></p>
        <button type="button" class="btn btn-texto" id="d-mas">${ico('mas', 'ico-s')} Añadir otro concepto</button>
      </fieldset>
      <div class="campo"><label for="d-iva">IVA</label><select id="d-iva">
        ${IVAS.map(([v, t]) => `<option value="${v}" ${v === iva0 ? 'selected' : ''}>${t}</option>`).join('')}
        ${IVAS.some(([v]) => v === iva0) ? '' : `<option value="${iva0}" selected>${numCorto(iva0)} %</option>`}
      </select><p class="ayuda" id="d-iva-texto"></p></div>
      <div class="campo"><label for="d-notas">Observaciones</label>
        <textarea id="d-notas" maxlength="1000" aria-describedby="d-notas-ayuda">${esc(src && src.tipo !== 'rectificativa' ? src.notas || '' : '')}</textarea>
        <p class="ayuda" id="d-notas-ayuda">Opcional. Sale en el documento: fecha y lugar del evento, forma de pago…</p></div>
      <dl class="totales" id="d-totales" aria-live="polite"></dl>
      <div class="aviso aviso-error" id="d-error" role="alert" hidden></div>
    </form>`,
    pie: `<button type="button" class="btn" data-cerrar>Cancelar</button>
      <button type="submit" form="f-doc" class="btn btn-primario">${tipo === 'presupuesto' ? (doc ? 'Guardar cambios' : 'Guardar presupuesto') : 'Revisar y emitir'}</button>`,
  });
  const f = $('#f-doc', d), ol = $('#d-lineas', f);
  let n = 0, validezTocada = !!doc;
  const filaLinea = (l, i) => `<li class="linea">
    <div class="campo concepto"><label for="l-c-${i}">Concepto</label>
      <input id="l-c-${i}" data-l="concepto" list="dl-conceptos-doc" maxlength="200" autocomplete="off" value="${esc(l.concepto || '')}"></div>
    <div class="campo cant"><label for="l-q-${i}">Cantidad</label><input id="l-q-${i}" data-l="cantidad" inputmode="decimal" value="${numCorto(l.cantidad ?? 1)}"></div>
    <div class="campo precio"><label for="l-p-${i}">Precio (€)</label><input id="l-p-${i}" data-l="precio" inputmode="decimal" placeholder="0,00" value="${l.precio === '' || l.precio == null ? '' : numInput(l.precio)}"></div>
    <p class="importe-linea num" data-importe aria-label="Importe de la línea"></p>
    <button type="button" class="btn btn-icono" data-quitar-linea aria-label="Quitar este concepto">${ico('papelera', 'ico-s')}</button></li>`;
  const totalForm = () => {
    let base = 0;
    $$('.linea', ol).forEach(li => {
      const c = parseImporte($('[data-l=cantidad]', li).value), p = parseImporte($('[data-l=precio]', li).value);
      const imp = c > 0 && p >= 0 ? redondear(c * p) : 0;
      base += imp; $('[data-importe]', li).textContent = eur(imp);
    });
    const pct = Number($('#d-iva', f).value), iva = redondear(base * pct / 100);
    return { base: redondear(base), pct, iva, total: redondear(base + iva) };
  };
  const recalcular = () => {
    const t = totalForm();
    $('#d-totales', f).innerHTML = `<dt>Base imponible</dt><dd class="num">${eur(t.base)}</dd>
      <dt>${t.pct ? `IVA ${numCorto(t.pct)} %` : 'IVA'}</dt><dd class="num">${t.pct ? eur(t.iva) : 'Exenta'}</dd>
      <dt class="total">Total</dt><dd class="num total">${eur(t.total)}</dd>`;
    $('#d-iva-texto', f).textContent = t.pct ? '' : aj.iva_texto || '';
    const filas = $$('[data-quitar-linea]', ol); filas.forEach(b => { b.disabled = filas.length === 1; });
  };
  const anadir = l => { ol.insertAdjacentHTML('beforeend', filaLinea(l, n++)); recalcular(); };
  lineas0.forEach(anadir);
  ol.addEventListener('input', () => { recalcular(); $('#d-lineas-err', f).hidden = true; });
  ol.addEventListener('click', e => { const b = e.target.closest('[data-quitar-linea]'); if (b && !b.disabled) { b.closest('li').remove(); recalcular(); } });
  ol.addEventListener('focusout', e => {
    const i = e.target;
    if (i.dataset.l === 'precio' && i.value.trim()) { const v = parseImporte(i.value); if (v >= 0) i.value = numInput(v); }
  });
  $('#d-mas', f).onclick = () => { anadir({ concepto: '', cantidad: 1, precio: '' }); $$('[data-l=concepto]', ol).at(-1).focus(); };
  $('#d-iva', f).onchange = recalcular;
  $('#d-validez', f)?.addEventListener('change', () => { validezTocada = true; });
  $('#d-fecha', f).addEventListener('change', e => {
    if (!validezTocada && $('#d-validez', f) && e.target.value) $('#d-validez', f).value = sumarDias(e.target.value, aj.validez_dias || 30);
  });
  $('#d-cli', f).addEventListener('change', e => {
    const c = (E.clientes || []).find(x => x.nombre.trim().toLowerCase() === e.target.value.trim().toLowerCase());
    if (!c) return;
    $('#d-nif', f).value = c.nif || ''; $('#d-tel', f).value = c.telefono || ''; $('#d-dir', f).value = c.direccion || ''; $('#d-email', f).value = c.email || '';
    if (c.nif || c.direccion) $('#d-cli-datos', f).open = true;
  });

  f.addEventListener('submit', async e => {
    e.preventDefault();
    const cliN = $('#d-cli', f);
    mostrarError(cliN, cliN.value.trim() ? '' : 'Escribe el nombre del cliente.');
    const lineas = $$('.linea', ol).map(li => ({
      concepto: $('[data-l=concepto]', li).value.trim(), cantidad: parseImporte($('[data-l=cantidad]', li).value), precio: parseImporte($('[data-l=precio]', li).value),
      vacia: !$('[data-l=concepto]', li).value.trim() && !$('[data-l=precio]', li).value.trim(),
    })).filter(l => !l.vacia);
    const t = totalForm();
    const errL = !lineas.length ? 'Añade al menos un concepto con su precio.'
      : lineas.some(l => !l.concepto) ? 'Cada concepto necesita una descripción.'
      : lineas.some(l => !(l.cantidad > 0)) ? 'La cantidad debe ser un número mayor que cero.'
      : lineas.some(l => !(l.precio >= 0)) ? 'Escribe los precios con números, por ejemplo 150,00.'
      : !(t.total > 0) ? 'El total tiene que ser mayor que cero.' : '';
    const el = $('#d-lineas-err', f); el.hidden = !errL; el.innerHTML = errL ? `${ico('alerta', 'ico-s')} ${esc(errL)}` : '';
    if (!cliN.value.trim()) return cliN.focus();
    if (errL) return $('[data-l=concepto]', ol)?.focus();
    const val = sel => $(sel, f).value.trim() || null;
    const cliente = { nombre: cliN.value.trim(), nif: val('#d-nif'), direccion: val('#d-dir'), email: val('#d-email'), telefono: val('#d-tel') };
    const datos = {
      fecha: $('#d-fecha', f).value, cliente, iva_pct: t.pct, iva_texto: t.pct ? null : aj.iva_texto || null, notas: val('#d-notas'),
      lineas: lineas.map(l => ({ concepto: l.concepto, cantidad: l.cantidad, precio: l.precio })),
    };
    if (!datos.fecha) { tostada('Elige la fecha.', { error: true }); return $('#d-fecha', f).focus(); }
    if (tipo === 'presupuesto') datos.validez_hasta = $('#d-validez', f).value || null;
    if (tipo === 'factura') {
      const ok = await confirmar({
        titulo: '¿Emitir la factura?', boton: 'Emitir factura',
        texto: `Se emitirá a nombre de <strong>${esc(cliente.nombre)}</strong> por <strong>${eur(t.total)}</strong>, con el siguiente número de ${datos.fecha.slice(0, 4)}.<br><br>
          Una vez emitida no se puede modificar ni borrar. Si hubiera un error, se corrige con una factura rectificativa.`,
      });
      if (!ok) return;
    }
    const caja = $('#d-error', f); caja.hidden = true;
    await conBoton(d.querySelector('[type=submit]'), async () => {
      try {
        datos.cliente_id = await guardarCliente(cliente);
        const res = doc
          ? await q(sb.from('documentos').update(datos).eq('id', doc.id).select().single())
          : await q(sb.from('documentos').insert({ ...datos, tipo, estado: tipo === 'presupuesto' ? 'borrador' : 'emitida' }).select().single());
        d.close();
        if (res.ejercicio !== E.ejercicio) { E.ejercicio = res.ejercicio; if (!E.ejercicios.includes(res.ejercicio)) E.ejercicios.push(res.ejercicio); pintarSelectorEjercicio(); }
        irA(`facturas?ver=${tipo === 'presupuesto' ? 'presupuestos' : 'facturas'}`);
        tostada(doc ? `${res.codigo} guardado` : tipo === 'presupuesto' ? `Presupuesto ${res.codigo} guardado` : `Factura ${res.codigo} emitida`);
        abrirDocumento(res.id);
      } catch (err) { caja.innerHTML = `${ico('alerta')}<p>${esc(mensajeError(err))}</p>`; caja.hidden = false; }
    });
  });
  setTimeout(() => (doc ? $('[data-l=concepto]', ol) : $('#d-cli', f)).focus(), 50);
}

// Vista previa en pantalla, con el mismo contenido que el PDF
function papel(doc) {
  const aj = E.ajustes || {}, cli = doc.cliente || {};
  const datosCoral = [aj.cif && `CIF ${aj.cif}`, aj.direccion, [aj.telefono, aj.email].filter(Boolean).join(' · ')].filter(Boolean);
  const datosCli = [cli.nif && `NIF ${cli.nif}`, cli.direccion, [cli.telefono, cli.email].filter(Boolean).join(' · ')].filter(Boolean);
  return `<article class="papel" aria-label="Vista previa del documento">
    <header class="papel-cabecera">
      <div class="papel-emisor"><div class="papel-logo" data-logo></div><div><p><strong>${esc(aj.nombre || '')}</strong></p>${datosCoral.map(x => `<p>${esc(x)}</p>`).join('')}</div></div>
      <div class="papel-titulo"><p class="papel-tipo">${TIPO_DOC[doc.tipo]}</p><p><strong>Nº ${esc(doc.codigo)}</strong></p>
        <p>Fecha: ${fecha(doc.fecha)}</p>${doc.tipo === 'presupuesto' && doc.validez_hasta ? `<p>Válido hasta: ${fecha(doc.validez_hasta)}</p>` : ''}</div>
    </header>
    <section class="papel-cliente"><p class="papel-etiqueta">Cliente</p><p><strong>${esc(cli.nombre || '')}</strong></p>${datosCli.map(x => `<p>${esc(x)}</p>`).join('')}</section>
    <table class="papel-lineas"><caption class="sr">Conceptos</caption>
      <thead><tr><th scope="col">Concepto</th><th scope="col">Cant.</th><th scope="col">Precio</th><th scope="col">Importe</th></tr></thead>
      <tbody>${doc.lineas.map(l => `<tr><td>${esc(l.concepto)}</td><td class="num">${numCorto(l.cantidad)}</td><td class="num">${eur(l.precio)}</td>
        <td class="num">${eur(redondear(l.cantidad * l.precio))}</td></tr>`).join('')}</tbody></table>
    <dl class="totales"><dt>Base imponible</dt><dd class="num">${eur(doc.base)}</dd>
      <dt>${Number(doc.iva_pct) ? `IVA ${numCorto(doc.iva_pct)} %` : 'IVA'}</dt><dd class="num">${Number(doc.iva_pct) ? eur(doc.iva_importe) : 'Exenta'}</dd>
      <dt class="total">Total</dt><dd class="num total">${eur(doc.total)}</dd></dl>
    ${!Number(doc.iva_pct) && doc.iva_texto ? `<p class="papel-nota">${esc(doc.iva_texto)}</p>` : ''}
    ${doc.notas ? `<p class="papel-etiqueta">Observaciones</p><p class="papel-nota">${esc(doc.notas)}</p>` : ''}
    ${doc.tipo !== 'presupuesto' && aj.iban ? `<p class="papel-etiqueta">Forma de pago</p><p class="papel-nota">Transferencia bancaria a la cuenta ${esc(aj.iban)}</p>` : ''}
    ${aj.pie_documentos ? `<p class="papel-pie">${esc(aj.pie_documentos)}</p>` : ''}
  </article>`;
}

let cacheLogo = null;
async function logoActual() {
  const ruta = E.ajustes?.logo_ruta;
  if (!ruta) return null;
  if (cacheLogo?.ruta === ruta) return cacheLogo;
  const { signedUrl } = await q(sb.storage.from('justificantes').createSignedUrl(ruta, 600));
  const blob = await (await fetch(signedUrl)).blob();
  const data = await new Promise(ok => { const r = new FileReader(); r.onload = () => ok(r.result); r.readAsDataURL(blob); });
  const img = await new Promise((ok, mal) => { const i = new Image(); i.onload = () => ok(i); i.onerror = mal; i.src = data; });
  cacheLogo = { ruta, data, url: signedUrl, ratio: img.naturalWidth / img.naturalHeight, formato: blob.type.includes('png') ? 'PNG' : 'JPEG' };
  return cacheLogo;
}

let moduloPdf = null;
async function generarPdf(doc) {
  if (!moduloPdf) moduloPdf = await import('https://cdn.jsdelivr.net/npm/jspdf@2.5.2/+esm');
  const JsPDF = moduloPdf.jsPDF || moduloPdf.default;
  const aj = E.ajustes || {}, cli = doc.cliente || {};
  const pdf = new JsPDF({ unit: 'mm', format: 'a4' });
  const M = 18, AN = 210, AL = 297, ancho = AN - 2 * M;
  const TINTA = [29, 29, 27], GRIS = [97, 97, 92], AZUL = [17, 48, 85], BLANCO = [255, 255, 255], LINEA = [220, 220, 214];
  const limpio = s => String(s ?? '').replace(/[  ]/g, ' ').replace(/−/g, '-');
  const euro = n => limpio(eur(n));
  const txt = (t, x, y, o = {}) => {
    pdf.setFont('helvetica', o.b ? 'bold' : 'normal'); pdf.setFontSize(o.s || 10); pdf.setTextColor(...(o.c || TINTA));
    pdf.text(limpio(t), x, y, { align: o.a || 'left' });
  };
  let y = M, xDatos = M;
  try {
    const logo = await logoActual();
    if (logo) { const h = 20, w = Math.min(42, h * logo.ratio); pdf.addImage(logo.data, logo.formato, M, y, w, h, undefined, 'FAST'); xDatos = M + w + 6; }
  } catch { /* sin logo si falla */ }
  txt(aj.nombre || '', xDatos, y + 5, { b: true, s: 13 });
  [aj.cif && `CIF ${aj.cif}`, aj.direccion, [aj.telefono, aj.email].filter(Boolean).join(' · ')].filter(Boolean)
    .forEach((l, i) => txt(l, xDatos, y + 11 + i * 4.6, { s: 9, c: GRIS }));
  txt(TIPO_DOC[doc.tipo].toUpperCase(), AN - M, y + 5, { b: true, s: 14, a: 'right', c: AZUL });
  txt(`Nº ${doc.codigo}`, AN - M, y + 12, { b: true, a: 'right' });
  txt(`Fecha: ${fecha(doc.fecha)}`, AN - M, y + 17, { s: 9, a: 'right' });
  if (doc.tipo === 'presupuesto' && doc.validez_hasta) txt(`Válido hasta: ${fecha(doc.validez_hasta)}`, AN - M, y + 22, { s: 9, a: 'right' });
  y += 32;

  const datosCli = [cli.nif && `NIF ${cli.nif}`, cli.direccion, [cli.telefono, cli.email].filter(Boolean).join(' · ')].filter(Boolean);
  const altoCli = 14 + datosCli.length * 4.6;
  pdf.setDrawColor(...LINEA); pdf.setFillColor(246, 246, 242); pdf.roundedRect(M, y, ancho, altoCli, 2, 2, 'FD');
  txt('CLIENTE', M + 4, y + 5.5, { s: 8, c: GRIS, b: true });
  txt(cli.nombre || '', M + 4, y + 11, { b: true, s: 11 });
  datosCli.forEach((l, i) => txt(l, M + 4, y + 16 + i * 4.6, { s: 9 }));
  y += altoCli + 8;

  const X = { concepto: M + 2, cant: M + ancho - 64, precio: M + ancho - 32, imp: M + ancho - 2 };
  const cabecera = () => {
    pdf.setFillColor(...AZUL); pdf.rect(M, y, ancho, 8, 'F');
    txt('Concepto', X.concepto, y + 5.5, { s: 9, b: true, c: BLANCO });
    [['Cant.', X.cant], ['Precio', X.precio], ['Importe', X.imp]].forEach(([t, x]) => txt(t, x, y + 5.5, { s: 9, b: true, c: BLANCO, a: 'right' }));
    y += 8;
  };
  cabecera();
  for (const l of doc.lineas) {
    pdf.setFont('helvetica', 'normal'); pdf.setFontSize(10);
    const partes = pdf.splitTextToSize(limpio(l.concepto), X.cant - X.concepto - 20);
    const alto = 4 + partes.length * 4.6;
    if (y + alto > AL - 60) { pdf.addPage(); y = M; cabecera(); }
    partes.forEach((p, i) => txt(p, X.concepto, y + 5.5 + i * 4.6));
    txt(numCorto(l.cantidad), X.cant, y + 5.5, { a: 'right' });
    txt(euro(l.precio), X.precio, y + 5.5, { a: 'right' });
    txt(euro(redondear(l.cantidad * l.precio)), X.imp, y + 5.5, { a: 'right' });
    y += alto; pdf.setDrawColor(...LINEA); pdf.line(M, y, M + ancho, y);
  }
  y += 7;
  if (y > AL - 50) { pdf.addPage(); y = M; }
  const fila = (et, val, o = {}) => { txt(et, M + ancho - 42, y, { a: 'right', s: o.s, b: o.b }); txt(val, X.imp, y, { a: 'right', s: o.s, b: o.b }); y += o.s ? 8 : 5.5; };
  fila('Base imponible', euro(doc.base));
  fila(Number(doc.iva_pct) ? `IVA ${numCorto(doc.iva_pct)} %` : 'IVA', Number(doc.iva_pct) ? euro(doc.iva_importe) : 'Exenta');
  pdf.setDrawColor(...AZUL); pdf.setLineWidth(0.4); pdf.line(M + ancho - 75, y - 2.5, M + ancho, y - 2.5); pdf.setLineWidth(0.2);
  y += 3; fila('TOTAL', euro(doc.total), { b: true, s: 13 }); y += 2;

  const parrafo = (titulo, texto) => {
    if (!texto) return;
    pdf.setFont('helvetica', 'normal'); pdf.setFontSize(9);
    const partes = pdf.splitTextToSize(limpio(texto), ancho);
    if (y + 8 + partes.length * 4.2 > AL - 16) { pdf.addPage(); y = M; }
    if (titulo) { txt(titulo, M, y, { s: 8, b: true, c: GRIS }); y += 4.5; }
    partes.forEach(p => { txt(p, M, y, { s: 9 }); y += 4.2; }); y += 3;
  };
  if (!Number(doc.iva_pct)) parrafo(null, doc.iva_texto);
  parrafo('OBSERVACIONES', doc.notas);
  if (doc.tipo !== 'presupuesto' && aj.iban) parrafo('FORMA DE PAGO', `Transferencia bancaria a la cuenta ${aj.iban}`);
  const paginas = pdf.getNumberOfPages();
  for (let i = 1; i <= paginas; i++) {
    pdf.setPage(i);
    if (aj.pie_documentos) txt(aj.pie_documentos, AN / 2, AL - 10, { s: 8, c: GRIS, a: 'center' });
    if (paginas > 1) txt(`Página ${i} de ${paginas}`, AN - M, AL - 6, { s: 8, c: GRIS, a: 'right' });
  }
  return pdf.output('blob');
}
const nombrePdf = doc => `${doc.codigo} ${slug(doc.cliente?.nombre || '')}.pdf`;

async function abrirDocumento(id) {
  let doc, rel;
  try {
    doc = await q(sb.from('documentos').select('*').eq('id', id).single());
    const ids = [doc.presupuesto_id, doc.rectifica_id].filter(Boolean);
    rel = await q(sb.from('documentos').select('id, codigo, tipo, estado')
      .or([`presupuesto_id.eq.${doc.id}`, `rectifica_id.eq.${doc.id}`, ...ids.map(x => `id.eq.${x}`)].join(',')));
  } catch (e) { return tostada(mensajeError(e), { error: true }); }
  const ed = puedeEditar();
  const esPres = doc.tipo === 'presupuesto';
  let cobroInfo = '';
  if (doc.estado === 'cobrada' && doc.movimiento_id) {
    const [mov, rec] = await Promise.all([
      sb.from('movimientos').select('numero, cuenta_id, fecha').eq('id', doc.movimiento_id).maybeSingle().then(r => r.data),
      sb.from('recibos').select('id, codigo').eq('documento_id', doc.id).eq('anulado', false).maybeSingle().then(r => r.data)]);
    const enCaja = mov && cuenta(mov.cuenta_id)?.tipo === 'caja';
    cobroInfo = `<div class="aviso aviso-info">${ico('ok')}<p>Cobrada el ${fecha(doc.cobrada_en)}${mov ? ` en «${esc(cuenta(mov.cuenta_id)?.nombre || '')}». Es el apunte nº ${mov.numero} del libro` : ''}.</p>
      ${mov ? `<button type="button" class="btn btn-texto acciones" data-ver-mov="${doc.movimiento_id}">Ver apunte</button>` : ''}</div>
      ${rec ? `<p><button type="button" class="btn btn-texto" data-ver-rec="${rec.id}">${ico('lapiz', 'ico-s')} Recibo firmado ${esc(rec.codigo)}</button></p>`
        : puedeEditar() && enCaja ? `<p><button type="button" class="btn" data-hacer-recibo>${ico('lapiz')} Hacer recibo firmado del cobro</button></p>` : ''}`;
  }
  const relacion = rel.map(r => `<button type="button" class="btn btn-texto" data-ir-doc="${r.id}">${ico(r.tipo === 'presupuesto' ? 'archivo' : 'factura', 'ico-s')}
    ${r.tipo === 'presupuesto' ? 'Viene del presupuesto' : r.tipo === 'rectificativa' ? 'Rectificada por' : esPres ? 'Facturado en' : 'Rectifica a'} ${esc(r.codigo)}</button>`).join('');

  const d = dialogo({
    titulo: `${TIPO_DOC[doc.tipo]} ${doc.codigo}`,
    cuerpo: `<div class="cabecera-doc">${chipEstado(doc)}
        ${esPres && ed && doc.estado !== 'facturado' ? `<label class="sr" for="doc-estado">Estado del presupuesto</label>
          <select id="doc-estado" class="select-compacto">${['borrador', 'enviado', 'aceptado', 'rechazado'].map(e => `<option value="${e}" ${doc.estado === e ? 'selected' : ''}>${ESTADOS_DOC[e][0]}</option>`).join('')}</select>` : ''}
        ${relacion}</div>
      ${cobroInfo}
      ${doc.tipo === 'factura' && doc.estado === 'rectificada' ? `<div class="aviso aviso-aviso">${ico('alerta')}<p>Esta factura está anulada por una rectificativa. Si se había cobrado y devolvisteis el dinero, apunta la devolución como gasto en el libro.</p></div>` : ''}
      <div class="acciones-doc">
        <button type="button" class="btn" id="b-pdf">${ico('descargar')} Descargar PDF</button>
        ${navigator.share ? `<button type="button" class="btn" id="b-compartir">${ico('compartir')} Compartir</button>` : ''}
        ${ed && esPres ? `<button type="button" class="btn btn-texto" id="b-duplicar">${ico('copiar', 'ico-s')} Duplicar</button>` : ''}
      </div>
      <div id="doc-papel">${papel(doc)}</div>`,
    pie: !ed ? '<button type="button" class="btn" data-cerrar>Cerrar</button>'
      : esPres ? `${doc.estado === 'borrador' ? `<button type="button" class="btn btn-texto izquierda" id="b-borrar">${ico('papelera', 'ico-s')} Borrar</button>` : ''}
          ${doc.estado !== 'facturado' ? `<button type="button" class="btn" id="b-editar-doc">${ico('lapiz')} Editar</button>` : ''}
          ${!['facturado', 'rechazado'].includes(doc.estado) ? `<button type="button" class="btn btn-primario" id="b-convertir">${ico('factura')} Convertir en factura</button>` : ''}`
      : doc.tipo === 'factura' ? `${doc.estado !== 'rectificada' ? `<button type="button" class="btn btn-texto izquierda" id="b-rectificar">Rectificar…</button>` : ''}
          ${doc.estado === 'cobrada' ? `<button type="button" class="btn" id="b-deshacer-cobro">${ico('deshacer')} Deshacer cobro</button>` : ''}
          ${doc.estado === 'emitida' ? `<button type="button" class="btn btn-primario" id="b-cobrar">${ico('caja')} Registrar cobro</button>` : ''}`
      : '<button type="button" class="btn" data-cerrar>Cerrar</button>',
  });
  logoActual().then(l => { const c = $('[data-logo]', d); if (l && c) c.innerHTML = `<img src="${l.data}" alt="">`; }).catch(() => {});
  const reabrir = () => { d.close(); abrirDocumento(doc.id); };
  const refrescarTodo = () => { if (location.hash.startsWith('#facturas')) enrutar(); };

  $$('[data-ir-doc]', d).forEach(b => b.addEventListener('click', () => { d.close(); abrirDocumento(b.dataset.irDoc); }));
  $('[data-ver-mov]', d)?.addEventListener('click', e => { d.close(); abrirDetalle(e.currentTarget.dataset.verMov); });
  $('[data-ver-rec]', d)?.addEventListener('click', e => { d.close(); abrirRecibo(e.currentTarget.dataset.verRec); });
  $('[data-hacer-recibo]', d)?.addEventListener('click', () => { d.close(); formRecibo({ documento: doc }); });
  $('#b-pdf', d).addEventListener('click', e => conBoton(e.currentTarget, async () => {
    try { descargar(nombrePdf(doc), await generarPdf(doc), 'application/pdf'); }
    catch (err) { tostada('No se pudo crear el PDF. ' + mensajeError(err), { error: true }); }
  }));
  $('#b-compartir', d)?.addEventListener('click', e => conBoton(e.currentTarget, async () => {
    try {
      const archivo = new File([await generarPdf(doc)], nombrePdf(doc), { type: 'application/pdf' });
      if (navigator.canShare?.({ files: [archivo] })) await navigator.share({ files: [archivo], title: `${TIPO_DOC[doc.tipo]} ${doc.codigo}` });
      else { descargar(archivo.name, archivo, 'application/pdf'); tostada('Este navegador no permite compartir archivos: se ha descargado el PDF.'); }
    } catch (err) { if (err?.name !== 'AbortError') tostada(mensajeError(err), { error: true }); }
  }));
  $('#b-duplicar', d)?.addEventListener('click', () => { d.close(); formDocumento({ tipo: 'presupuesto', base: doc }); });
  $('#b-editar-doc', d)?.addEventListener('click', () => { d.close(); formDocumento({ tipo: 'presupuesto', doc }); });
  $('#doc-estado', d)?.addEventListener('change', async e => {
    const antes = doc.estado, nuevo = e.target.value;
    try {
      await q(sb.from('documentos').update({ estado: nuevo }).eq('id', doc.id));
      refrescarTodo(); reabrir();
      tostada(`${doc.codigo}: ${ESTADOS_DOC[nuevo][0].toLowerCase()}`, { deshacer: async () => { await q(sb.from('documentos').update({ estado: antes }).eq('id', doc.id)); refrescarTodo(); } });
    } catch (err) { e.target.value = antes; tostada(mensajeError(err), { error: true }); }
  });
  $('#b-borrar', d)?.addEventListener('click', async () => {
    if (!await confirmar({ titulo: `¿Borrar el presupuesto ${doc.codigo}?`, texto: 'Solo se pueden borrar los presupuestos en borrador. Esta acción no se puede deshacer.', boton: 'Borrar presupuesto', peligro: true })) return;
    try { await q(sb.from('documentos').delete().eq('id', doc.id)); d.close(); refrescarTodo(); tostada(`Presupuesto ${doc.codigo} borrado`); }
    catch (err) { tostada(mensajeError(err), { error: true }); }
  });
  $('#b-convertir', d)?.addEventListener('click', () => dialogoFecha({
    titulo: `Convertir ${doc.codigo} en factura`, boton: 'Emitir factura',
    texto: `Se emitirá una factura a nombre de <strong>${esc(doc.cliente.nombre)}</strong> por <strong>${eur(doc.total)}</strong> con los mismos conceptos. Una vez emitida no se puede modificar.`,
    accion: async ({ fecha: f }) => {
      const nuevaId = await q(sb.rpc('convertir_presupuesto', { p_presupuesto: doc.id, p_fecha: f }));
      d.close(); irA('facturas?ver=facturas'); tostada('Factura emitida'); abrirDocumento(nuevaId);
    },
  }));
  $('#b-rectificar', d)?.addEventListener('click', () => dialogoFecha({
    titulo: `Rectificar la factura ${doc.codigo}`, boton: 'Emitir rectificativa', peligro: true, motivo: 'Motivo de la rectificación',
    texto: `Se emitirá una factura rectificativa con los importes en negativo y ${doc.codigo} quedará anulada.
      ${doc.estado === 'cobrada' ? '<br><br>Como ya estaba cobrada, si devolvéis el dinero apunta la devolución como gasto en el libro.' : ''}
      <br><br>Si solo había que cambiar algo, después haz una factura nueva con los datos correctos.`,
    accion: async ({ fecha: f, motivo }) => {
      const nuevaId = await q(sb.rpc('rectificar_factura', { p_factura: doc.id, p_fecha: f, p_motivo: motivo }));
      d.close(); irA('facturas?ver=facturas'); tostada('Factura rectificativa emitida'); abrirDocumento(nuevaId);
    },
  }));
  $('#b-cobrar', d)?.addEventListener('click', () => formCobro(doc, () => { d.close(); refrescarTodo(); abrirDocumento(doc.id); }));
  $('#b-deshacer-cobro', d)?.addEventListener('click', async () => {
    if (!await confirmar({ titulo: '¿Deshacer el cobro?', texto: `El ingreso del libro quedará anulado y la factura ${doc.codigo} volverá a «pendiente de cobro».`, boton: 'Deshacer cobro' })) return;
    try { await q(sb.rpc('deshacer_cobro', { p_factura: doc.id })); refrescarTodo(); reabrir(); tostada('Cobro deshecho'); }
    catch (err) { tostada(mensajeError(err), { error: true }); }
  });
}

// Diálogo con fecha (y motivo opcional) para convertir o rectificar
function dialogoFecha({ titulo, texto, boton, peligro = false, motivo = null, accion }) {
  const d = dialogo({
    titulo, cerrarFuera: false,
    cuerpo: `<form class="formulario" id="f-fecha" novalidate><p>${texto}</p>
      <div class="campo"><label for="ff-fecha">Fecha de la factura</label><input id="ff-fecha" type="date" required value="${hoy()}"></div>
      ${motivo ? `<div class="campo"><label for="ff-motivo">${esc(motivo)}</label><textarea id="ff-motivo" maxlength="300" required aria-describedby="ff-motivo-err"></textarea><p class="error" id="ff-motivo-err" hidden></p></div>` : ''}
      <div class="aviso aviso-error" id="ff-error" role="alert" hidden></div></form>`,
    pie: `<button type="button" class="btn" data-cerrar>Cancelar</button><button type="submit" form="f-fecha" class="btn ${peligro ? 'btn-peligro' : 'btn-primario'}">${esc(boton)}</button>`,
  });
  $('#f-fecha', d).addEventListener('submit', async e => {
    e.preventDefault();
    const m = $('#ff-motivo', d);
    if (m && !m.value.trim()) { mostrarError(m, 'Escribe el motivo: saldrá en la factura rectificativa.'); return m.focus(); }
    await conBoton(d.querySelector('[type=submit]'), async () => {
      try { await accion({ fecha: $('#ff-fecha', d).value, motivo: m?.value.trim() }); d.close(); }
      catch (err) { const box = $('#ff-error', d); box.innerHTML = `${ico('alerta')}<p>${esc(mensajeError(err))}</p>`; box.hidden = false; }
    });
  });
}

function formCobro(doc, alTerminar) {
  const activas = E.cuentas.filter(c => c.activa);
  const cats = E.categorias.filter(c => c.tipo === 'ingreso' && c.activa);
  const catDef = (cats.find(c => /boda/i.test(c.nombre) && /boda/i.test(JSON.stringify(doc.lineas) + (doc.notas || '')))
    || cats.find(c => /actuaci/i.test(c.nombre)) || cats[0])?.id;
  const d = dialogo({
    titulo: `Registrar cobro de ${doc.codigo}`, cerrarFuera: false,
    cuerpo: `<form class="formulario" id="f-cobro" novalidate>
      <p>Se apuntará en el libro un ingreso de <strong class="num">${eur(doc.total)}</strong> de ${esc(doc.cliente.nombre)}.</p>
      <div class="fila-campos">
        <div class="campo"><label for="c-fecha">Fecha del cobro</label><input id="c-fecha" type="date" required value="${hoy()}"></div>
        <div class="campo"><label for="c-cuenta">Cobrado en</label><select id="c-cuenta">${activas.map(c => `<option value="${c.id}" ${c.tipo === 'banco' ? 'selected' : ''}>${esc(c.nombre)}</option>`).join('')}</select></div>
      </div>
      <div class="campo"><label for="c-cat">Categoría</label><select id="c-cat">${cats.map(c => `<option value="${c.id}" ${c.id === catDef ? 'selected' : ''}>${esc(c.nombre)}</option>`).join('')}</select></div>
      <div class="aviso aviso-error" id="c-error" role="alert" hidden></div></form>`,
    pie: `<button type="button" class="btn" data-cerrar>Cancelar</button><button type="submit" form="f-cobro" class="btn btn-primario">Registrar cobro</button>`,
  });
  $('#f-cobro', d).addEventListener('submit', async e => {
    e.preventDefault();
    await conBoton(d.querySelector('[type=submit]'), async () => {
      try {
        const movId = await q(sb.rpc('cobrar_factura', { p_factura: doc.id, p_cuenta: $('#c-cuenta', d).value, p_fecha: $('#c-fecha', d).value, p_categoria: $('#c-cat', d).value }));
        const mov = await sb.from('movimientos').select('numero').eq('id', movId).maybeSingle().then(r => r.data);
        d.close(); alTerminar?.();
        tostada(`Cobro registrado${mov ? `: apunte nº ${mov.numero} del libro` : ''}`, { deshacer: async () => { await q(sb.rpc('deshacer_cobro', { p_factura: doc.id })); if (location.hash.startsWith('#facturas')) enrutar(); } });
      } catch (err) { const box = $('#c-error', d); box.innerHTML = `${ico('alerta')}<p>${esc(mensajeError(err))}</p>`; box.hidden = false; }
    });
  });
}

// ======================================================================
// Recibos firmados (tanda 3)
// ======================================================================
function numeroALetras(importe) {
  const U = ['', 'uno', 'dos', 'tres', 'cuatro', 'cinco', 'seis', 'siete', 'ocho', 'nueve', 'diez', 'once', 'doce', 'trece', 'catorce', 'quince',
    'dieciséis', 'diecisiete', 'dieciocho', 'diecinueve', 'veinte', 'veintiuno', 'veintidós', 'veintitrés', 'veinticuatro', 'veinticinco',
    'veintiséis', 'veintisiete', 'veintiocho', 'veintinueve'];
  const D = ['', '', '', 'treinta', 'cuarenta', 'cincuenta', 'sesenta', 'setenta', 'ochenta', 'noventa'];
  const C = ['', 'ciento', 'doscientos', 'trescientos', 'cuatrocientos', 'quinientos', 'seiscientos', 'setecientos', 'ochocientos', 'novecientos'];
  const apocopar = s => s.replace(/veintiuno$/, 'veintiún').replace(/uno$/, 'un');
  const menor100 = n => (n < 30 ? U[n] : D[Math.floor(n / 10)] + (n % 10 ? ' y ' + U[n % 10] : ''));
  const menor1000 = n => (n === 100 ? 'cien' : `${C[Math.floor(n / 100)]} ${n % 100 ? menor100(n % 100) : ''}`.trim());
  const entero = n => {
    if (n === 0) return 'cero';
    const mill = Math.floor(n / 1e6), miles = Math.floor((n % 1e6) / 1000), resto = n % 1000;
    return [mill ? (mill === 1 ? 'un millón' : `${apocopar(entero(mill))} millones`) : '',
      miles ? (miles === 1 ? 'mil' : `${apocopar(menor1000(miles))} mil`) : '', resto ? menor1000(resto) : ''].filter(Boolean).join(' ');
  };
  const cent = Math.round(Math.abs(importe) * 100), e = Math.floor(cent / 100), c = cent % 100;
  return `${apocopar(entero(e))} ${e === 1 ? 'euro' : 'euros'}${c ? ` con ${apocopar(menor100(c))} ${c === 1 ? 'céntimo' : 'céntimos'}` : ''}`;
}
const fechaLarga = iso => new Intl.DateTimeFormat('es-ES', { day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(iso + 'T12:00:00'));
function textoRecibo(r) {
  const aj = E.ajustes || {};
  const coral = `${aj.nombre || 'la coral'}${aj.cif ? ` (CIF ${aj.cif})` : ''}`;
  const persona = `${r.persona || '…'}${r.dni ? `, con DNI ${r.dni},` : ''}`;
  const cantidad = `la cantidad de ${eur(r.importe || 0)} (${numeroALetras(r.importe || 0)}) en concepto de ${r.concepto || '…'}`;
  return r.tipo === 'pago' ? `${persona} declara haber recibido de ${coral} ${cantidad}.` : `${coral} declara haber recibido de ${persona} ${cantidad}.`;
}
const lugarFecha = r => `En ${E.ajustes?.localidad || '…'}, a ${fechaLarga(r.fecha)}.`;

// Recuadro de firma con el dedo o el ratón
function padFirma(canvas) {
  const ctx = canvas.getContext('2d');
  let trazos = 0, dibujando = false, ult = null;
  const ajustar = () => {
    const r = canvas.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(r.width * dpr); canvas.height = Math.round(r.height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    Object.assign(ctx, { lineWidth: 2.4, lineCap: 'round', lineJoin: 'round', strokeStyle: '#1d1d1b', fillStyle: '#1d1d1b' });
    trazos = 0;
  };
  const pos = e => { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  canvas.addEventListener('pointerdown', e => {
    e.preventDefault(); dibujando = true; canvas.setPointerCapture(e.pointerId); ult = pos(e);
    ctx.beginPath(); ctx.arc(ult.x, ult.y, 1.2, 0, Math.PI * 2); ctx.fill();
  });
  canvas.addEventListener('pointermove', e => {
    if (!dibujando) return;
    const p = pos(e); ctx.beginPath(); ctx.moveTo(ult.x, ult.y); ctx.lineTo(p.x, p.y); ctx.stroke(); ult = p; trazos++;
  });
  const fin = () => { if (dibujando) { dibujando = false; canvas.dispatchEvent(new Event('firmado')); } };
  canvas.addEventListener('pointerup', fin); canvas.addEventListener('pointercancel', fin);
  ajustar();
  // La firma se guarda a tamaño de pantalla (no a doble resolución): pesa poco y se ve nítida en el PDF
  const png = () => {
    const r = canvas.getBoundingClientRect();
    const copia = Object.assign(document.createElement('canvas'), { width: Math.round(r.width), height: Math.round(r.height) });
    copia.getContext('2d').drawImage(canvas, 0, 0, copia.width, copia.height);
    return new Promise(ok => copia.toBlob(ok, 'image/png'));
  };
  return { vacia: () => trazos < 8, borrar: ajustar, ajustar, png };
}
const bloqueFirma = (id, etiqueta) => `<div class="campo firma" id="${id}-caja">
  <span class="etiqueta-campo" id="${id}-et">${esc(etiqueta)}</span>
  <canvas class="lienzo-firma" id="${id}" role="img" aria-labelledby="${id}-et" aria-describedby="${id}-ayuda ${id}-err"></canvas>
  <div class="firma-pie"><span class="ayuda" id="${id}-ayuda">Firma con el dedo o con el ratón dentro del recuadro.</span>
    <button type="button" class="btn btn-texto" data-borrar-firma="${id}">Borrar y repetir</button></div>
  <p class="error" id="${id}-err" hidden></p></div>`;

const cacheImagenes = new Map();
async function imagenAlmacen(ruta) {
  if (!ruta) return null;
  if (cacheImagenes.has(ruta)) return cacheImagenes.get(ruta);
  const { signedUrl } = await q(sb.storage.from('justificantes').createSignedUrl(ruta, 600));
  const blob = await (await fetch(signedUrl)).blob();
  const data = await new Promise(ok => { const r = new FileReader(); r.onload = () => ok(r.result); r.readAsDataURL(blob); });
  const img = await new Promise((ok, mal) => { const i = new Image(); i.onload = () => ok(i); i.onerror = mal; i.src = data; });
  const res = { data, ratio: img.naturalWidth / img.naturalHeight };
  cacheImagenes.set(ruta, res);
  return res;
}

function formRecibo({ tipo = 'pago', documento = null } = {}) {
  const deFactura = !!documento;
  const activas = E.cuentas.filter(c => c.activa);
  const caja0 = (activas.find(c => c.tipo === 'caja') || activas[0])?.id;
  const opcCat = t => E.categorias.filter(c => c.tipo === t && c.activa).map(c => `<option value="${c.id}">${esc(c.nombre)}</option>`).join('');
  const d = dialogo({
    titulo: deFactura ? `Recibo del cobro de ${documento.codigo}` : 'Nuevo recibo firmado', cerrarFuera: false,
    cuerpo: `<form class="formulario" id="f-rec" novalidate>
      ${deFactura ? '' : `<fieldset class="campo" style="border:0;padding:0;margin:0"><legend class="etiqueta-campo" style="margin-bottom:var(--space-1)">Tipo de recibo</legend>
        <div class="segmentos">
          <input type="radio" name="rtipo" id="r-pago" value="pago" ${tipo === 'pago' ? 'checked' : ''}><label for="r-pago">La coral paga</label>
          <input type="radio" name="rtipo" id="r-cobro" value="cobro" ${tipo === 'cobro' ? 'checked' : ''}><label for="r-cobro">La coral cobra</label>
        </div><p class="ayuda" id="r-tipo-ayuda"></p></fieldset>`}
      <div class="fila-campos">
        <div class="campo"><label for="r-persona" id="r-persona-et">Quién recibe el dinero</label>
          <input id="r-persona" required maxlength="150" autocomplete="off" list="dl-terceros-rec" value="${esc(documento?.cliente?.nombre || '')}" aria-describedby="r-persona-err">
          <datalist id="dl-terceros-rec">${[...new Set(E.movs.map(m => m.tercero).filter(Boolean))].slice(0, 200).map(t => `<option value="${esc(t)}"></option>`).join('')}</datalist>
          <p class="error" id="r-persona-err" hidden></p></div>
        <div class="campo"><label for="r-dni">DNI</label><input id="r-dni" maxlength="20" autocomplete="off" value="${esc(documento?.cliente?.nif || '')}" aria-describedby="r-dni-ayuda"><p class="ayuda" id="r-dni-ayuda">Opcional.</p></div>
      </div>
      <div class="fila-campos">
        <div class="campo"><label for="r-importe">Importe (€)</label>
          <input id="r-importe" class="input-importe" inputmode="decimal" required placeholder="0,00" ${deFactura ? `value="${numInput(documento.total)}" readonly` : ''} aria-describedby="r-importe-err"><p class="error" id="r-importe-err" hidden></p></div>
        <div class="campo"><label for="r-fecha">Fecha</label><input id="r-fecha" type="date" required value="${deFactura ? documento.cobrada_en : hoy()}"></div>
      </div>
      <div class="campo"><label for="r-concepto">Concepto</label>
        <input id="r-concepto" required maxlength="200" autocomplete="off" value="${deFactura ? `cobro en efectivo de la factura ${esc(documento.codigo)}` : ''}" placeholder="Ej.: acompañamiento al órgano en el concierto de Navidad" aria-describedby="r-concepto-err">
        <p class="error" id="r-concepto-err" hidden></p></div>
      ${deFactura ? '' : `<div class="fila-campos">
        <div class="campo"><label for="r-cuenta" id="r-cuenta-et">Pagado con</label><select id="r-cuenta">${activas.map(c => `<option value="${c.id}" ${c.id === caja0 ? 'selected' : ''}>${esc(c.nombre)}</option>`).join('')}</select></div>
        <div class="campo"><label for="r-cat">Categoría</label><select id="r-cat" aria-describedby="r-cat-err"></select><p class="error" id="r-cat-err" hidden></p></div>
      </div>`}
      <div class="campo"><label for="r-firmante">Firma por la coral</label><input id="r-firmante" maxlength="100" value="${esc(E.perfil.nombre)}" aria-describedby="r-firmante-ayuda">
        <p class="ayuda" id="r-firmante-ayuda">Nombre de quien firma en nombre de la coral, si firma.</p></div>
      <div class="texto-recibo" aria-live="polite"><p class="papel-etiqueta">Lo que se firma</p><p id="r-texto"></p><p id="r-lugar" class="muted pequeno"></p></div>
      <div id="r-firmas"></div>
      <label class="casilla" id="r-otra-caja"><input type="checkbox" id="r-otra"> <span id="r-otra-et"></span></label>
      <div class="aviso aviso-error" id="r-error" role="alert" hidden></div>
    </form>`,
    pie: `<button type="button" class="btn" data-cerrar>Cancelar</button><button type="submit" form="f-rec" class="btn btn-primario">Guardar recibo firmado</button>`,
  });
  const f = $('#f-rec', d);
  const tipoActual = () => (deFactura ? 'cobro' : $('input[name=rtipo]:checked', f).value);
  const pads = {};
  const activarPad = c => { pads[c.id] = padFirma(c); c.addEventListener('firmado', () => { $(`#${c.id}-err`, f).hidden = true; }); };
  const segundaFirma = () => (tipoActual() === 'pago' ? ['fc', 'Firma por la coral'] : ['fp', 'Firma de quien paga']);
  // Al cambiar de tipo se rehacen los recuadros; al marcar la segunda firma solo se añade o se quita esa, sin borrar la primera
  const pintarFirmas = () => {
    const t = tipoActual();
    const principal = t === 'pago' ? ['fp', 'Firma de quien recibe el dinero'] : ['fc', 'Firma por la coral'];
    $('#r-firmas', f).innerHTML = bloqueFirma(...principal);
    $('#r-otra', f).checked = false;
    $('#r-otra-et', f).textContent = t === 'pago' ? 'Firmar también por la coral' : 'Que firme también quien paga';
    for (const k of Object.keys(pads)) delete pads[k];
    activarPad($(`#${principal[0]}`, f));
  };
  const alternarSegunda = () => {
    const [id, etiqueta] = segundaFirma();
    if ($('#r-otra', f).checked) { $('#r-firmas', f).insertAdjacentHTML('beforeend', bloqueFirma(id, etiqueta)); activarPad($(`#${id}`, f)); }
    else { $(`#${id}-caja`, f)?.remove(); delete pads[id]; }
  };
  const pintarTipo = () => {
    const t = tipoActual();
    if (!deFactura) {
      $('#r-tipo-ayuda', f).textContent = t === 'pago' ? 'Para pagos en mano: firma quien recibe el dinero (un músico, un reembolso…). Se apunta como gasto.'
        : 'Para cobros en mano: firma el tesorero en nombre de la coral. Se apunta como ingreso.';
      $('#r-cuenta-et', f).textContent = t === 'pago' ? 'Pagado con' : 'Cobrado en';
      const sel = $('#r-cat', f), previa = sel.value;
      sel.innerHTML = `<option value="">Elige una categoría</option>${opcCat(t === 'pago' ? 'gasto' : 'ingreso')}`;
      if ([...sel.options].some(o => o.value === previa)) sel.value = previa;
    }
    $('#r-persona-et', f).textContent = t === 'pago' ? 'Quién recibe el dinero' : 'Quién paga';
    pintarFirmas(); pintarTexto();
  };
  const leer = () => ({ tipo: tipoActual(), persona: $('#r-persona', f).value.trim(), dni: $('#r-dni', f).value.trim(),
    importe: parseImporte($('#r-importe', f).value), concepto: $('#r-concepto', f).value.trim(), fecha: $('#r-fecha', f).value });
  const pintarTexto = () => {
    const r = leer();
    $('#r-texto', f).textContent = textoRecibo({ ...r, importe: r.importe > 0 ? r.importe : 0 });
    $('#r-lugar', f).textContent = r.fecha ? lugarFecha(r) : '';
  };
  f.addEventListener('input', e => { if (!e.target.closest('.lienzo-firma')) pintarTexto(); });
  $$('input[name=rtipo]', f).forEach(x => x.addEventListener('change', pintarTipo));
  $('#r-otra', f).addEventListener('change', alternarSegunda);
  f.addEventListener('click', e => { const b = e.target.closest('[data-borrar-firma]'); if (b) pads[b.dataset.borrarFirma]?.borrar(); });
  const imp = $('#r-importe', f);
  imp.addEventListener('blur', () => { const n = parseImporte(imp.value); if (n > 0) imp.value = numInput(n); pintarTexto(); });
  addEventListener('resize', () => Object.values(pads).forEach(p => p.vacia() && p.ajustar()), { once: true });
  pintarTipo();

  f.addEventListener('submit', async e => {
    e.preventDefault();
    const r = leer(), t = r.tipo;
    mostrarError($('#r-persona', f), r.persona ? '' : t === 'pago' ? 'Escribe quién recibe el dinero.' : 'Escribe quién paga.');
    mostrarError(imp, r.importe > 0 ? '' : 'Escribe un importe mayor que cero.');
    mostrarError($('#r-concepto', f), r.concepto ? '' : 'Escribe el concepto.');
    if (!deFactura) mostrarError($('#r-cat', f), $('#r-cat', f).value ? '' : 'Elige una categoría.');
    const obligatoria = t === 'pago' ? 'fp' : 'fc';
    const faltaFirma = Object.entries(pads).filter(([id, p]) => p.vacia() && (id === obligatoria || $('#r-otra', f).checked));
    faltaFirma.forEach(([id]) => { const el = $(`#${id}-err`, f); el.hidden = false; el.innerHTML = `${ico('alerta', 'ico-s')} Falta esta firma.`; });
    const malo = f.querySelector('[aria-invalid="true"]');
    if (malo) return malo.focus();
    if (faltaFirma.length) return $(`#${faltaFirma[0][0]}`, f).scrollIntoView({ block: 'center' });
    const caja = $('#r-error', f); caja.hidden = true;
    await conBoton(d.querySelector('[type=submit]'), async () => {
      try {
        const rutas = {};
        for (const [id, p] of Object.entries(pads)) {
          if (p.vacia()) continue;
          const ruta = `recibos/${crypto.randomUUID()}.png`;
          await q(sb.storage.from('justificantes').upload(ruta, await p.png(), { contentType: 'image/png' }));
          rutas[id] = ruta;
        }
        const res = await q(sb.rpc('crear_recibo', {
          p_tipo: t, p_fecha: r.fecha, p_persona: r.persona, p_dni: r.dni || null, p_importe: r.importe, p_concepto: r.concepto,
          p_cuenta: deFactura ? null : $('#r-cuenta', f).value, p_categoria: deFactura ? null : $('#r-cat', f).value,
          p_firma_persona: rutas.fp || null, p_firma_coral: rutas.fc || null,
          p_firmante_coral: rutas.fc ? $('#r-firmante', f).value.trim() || null : null, p_documento: documento?.id || null,
        }));
        d.close();
        let aviso = '';
        try { await adjuntarPdfRecibo(res.id); } catch (err) { aviso = ' El PDF no se pudo adjuntar al libro; puedes hacerlo desde el recibo.'; }
        if (location.hash.startsWith('#facturas') || location.hash.startsWith('#inicio') || location.hash.startsWith('#libro') || !location.hash) enrutar();
        tostada(`Recibo ${res.codigo} guardado y apuntado en el libro.${aviso}`, { error: !!aviso });
        abrirRecibo(res.id);
      } catch (err) { caja.innerHTML = `${ico('alerta')}<p>${esc(mensajeError(err))}</p>`; caja.hidden = false; }
    });
  });
  setTimeout(() => $('#r-persona', f).focus(), 50);
}

// Genera el PDF firmado y lo deja como justificante del apunte
async function adjuntarPdfRecibo(id) {
  const r = await q(sb.from('recibos').select('*').eq('id', id).single());
  if (r.pdf_ruta || !r.movimiento_id) return r;
  const blob = await generarPdfRecibo(r);
  const nombre = `${r.codigo} ${slug(r.persona)}.pdf`;
  const ruta = `${r.ejercicio}/${r.movimiento_id}/${slug(nombre)}`;
  await q(sb.storage.from('justificantes').upload(ruta, blob, { contentType: 'application/pdf', upsert: true }));
  await q(sb.from('justificantes').insert({ movimiento_id: r.movimiento_id, ruta, nombre, tipo_mime: 'application/pdf', tamano: blob.size }));
  await q(sb.from('recibos').update({ pdf_ruta: ruta }).eq('id', r.id));
  return r;
}

async function generarPdfRecibo(r) {
  if (!moduloPdf) moduloPdf = await import('https://cdn.jsdelivr.net/npm/jspdf@2.5.2/+esm');
  const JsPDF = moduloPdf.jsPDF || moduloPdf.default;
  const aj = E.ajustes || {};
  const pdf = new JsPDF({ unit: 'mm', format: 'a4' });
  const M = 18, AN = 210, ancho = AN - 2 * M;
  const TINTA = [29, 29, 27], GRIS = [97, 97, 92], AZUL = [17, 48, 85], LINEA = [200, 200, 194];
  const limpio = s => String(s ?? '').replace(/[  ]/g, ' ');
  const txt = (t, x, y, o = {}) => { pdf.setFont('helvetica', o.b ? 'bold' : 'normal'); pdf.setFontSize(o.s || 10); pdf.setTextColor(...(o.c || TINTA)); pdf.text(limpio(t), x, y, { align: o.a || 'left', angle: o.angle }); };
  let y = M + 6, xDatos = M + 6;
  try {
    const logo = await logoActual();
    if (logo) { const h = 16, w = Math.min(34, h * logo.ratio); pdf.addImage(logo.data, logo.formato, M + 6, y, w, h, undefined, 'FAST'); xDatos = M + 6 + w + 5; }
  } catch {}
  txt(aj.nombre || '', xDatos, y + 5, { b: true, s: 12 });
  [aj.cif && `CIF ${aj.cif}`, aj.direccion].filter(Boolean).forEach((l, i) => txt(l, xDatos, y + 10 + i * 4.4, { s: 9, c: GRIS }));
  txt(r.tipo === 'pago' ? 'RECIBO DE PAGO' : 'RECIBO DE COBRO', AN - M - 6, y + 5, { b: true, s: 13, a: 'right', c: AZUL });
  txt(`Nº ${r.codigo}`, AN - M - 6, y + 11, { b: true, a: 'right' });
  y += 26;
  pdf.setFillColor(238, 242, 250); pdf.roundedRect(AN - M - 6 - 60, y, 60, 13, 2, 2, 'F');
  txt(limpio(eur(r.importe)), AN - M - 9, y + 9, { b: true, s: 15, a: 'right' });
  y += 22;
  pdf.setFont('helvetica', 'normal'); pdf.setFontSize(11.5);
  const lineas = pdf.splitTextToSize(limpio(textoRecibo(r)), ancho - 12);
  lineas.forEach((l, i) => txt(l, M + 6, y + i * 6, { s: 11.5 }));
  y += lineas.length * 6 + 6;
  txt(lugarFecha(r), AN - M - 6, y, { a: 'right', s: 10.5 });
  y += 10;
  const firma = async (ruta, x, etiqueta, nombre) => {
    const w = (ancho - 24) / 2, h = 30;
    pdf.setDrawColor(...LINEA); pdf.line(x, y + h, x + w, y + h);
    try { const im = await imagenAlmacen(ruta); if (im) { const iw = Math.min(w, h * im.ratio); pdf.addImage(im.data, 'PNG', x + (w - iw) / 2, y, iw, h, undefined, 'FAST'); } } catch {}
    txt(etiqueta, x + w / 2, y + h + 5, { s: 8.5, c: GRIS, a: 'center' });
    if (nombre) txt(nombre, x + w / 2, y + h + 9.5, { s: 9.5, a: 'center' });
  };
  const xIzq = M + 6, xDer = M + 6 + (ancho - 24) / 2 + 12;
  if (r.tipo === 'pago') {
    await firma(r.firma_persona, xIzq, 'Recibí (firma de quien recibe)', r.persona);
    if (r.firma_coral) await firma(r.firma_coral, xDer, `Por ${aj.nombre || 'la coral'}`, r.firmante_coral);
  } else {
    await firma(r.firma_coral, xIzq, `Recibí, por ${aj.nombre || 'la coral'}`, r.firmante_coral);
    if (r.firma_persona) await firma(r.firma_persona, xDer, 'Conforme (firma de quien paga)', r.persona);
  }
  y += 48;
  pdf.setDrawColor(...LINEA); pdf.roundedRect(M, M, ancho, y - M, 3, 3, 'S');
  if (r.anulado) {
    txt('ANULADO', AN / 2, M + (y - M) / 2 + 18, { b: true, s: 54, c: [179, 38, 30], a: 'center', angle: 18 });
    txt(`Anulado: ${r.motivo_anulacion || ''}`, M, y + 8, { s: 9, c: [179, 38, 30] });
  }
  return pdf.output('blob');
}

async function papelRecibo(r) {
  const aj = E.ajustes || {};
  const [fp, fc] = await Promise.all([imagenAlmacen(r.firma_persona).catch(() => null), imagenAlmacen(r.firma_coral).catch(() => null)]);
  const caja = (img, etiqueta, nombre) => `<div class="papel-firma">${img ? `<img src="${img.data}" alt="Firma de ${esc(nombre || '')}">` : '<span></span>'}
    <p class="papel-etiqueta">${esc(etiqueta)}</p>${nombre ? `<p>${esc(nombre)}</p>` : ''}</div>`;
  const firmas = r.tipo === 'pago'
    ? caja(fp, 'Recibí (firma de quien recibe)', r.persona) + (fc ? caja(fc, `Por ${aj.nombre || 'la coral'}`, r.firmante_coral) : '')
    : caja(fc, `Recibí, por ${aj.nombre || 'la coral'}`, r.firmante_coral) + (fp ? caja(fp, 'Conforme (firma de quien paga)', r.persona) : '');
  return `<article class="papel papel-recibo ${r.anulado ? 'anulado' : ''}" aria-label="Vista previa del recibo">
    <header class="papel-cabecera"><div class="papel-emisor"><div><p><strong>${esc(aj.nombre || '')}</strong></p>${aj.cif ? `<p>CIF ${esc(aj.cif)}</p>` : ''}</div></div>
      <div class="papel-titulo"><p class="papel-tipo">${r.tipo === 'pago' ? 'Recibo de pago' : 'Recibo de cobro'}</p><p><strong>Nº ${esc(r.codigo)}</strong></p>
        <p class="papel-importe num">${eur(r.importe)}</p></div></header>
    <p class="papel-texto">${esc(textoRecibo(r))}</p>
    <p class="papel-lugar">${esc(lugarFecha(r))}</p>
    <div class="papel-firmas">${firmas}</div>
    ${r.anulado ? `<p class="sello-anulado" aria-hidden="true">Anulado</p>` : ''}
  </article>`;
}

async function abrirRecibo(id) {
  let r, fac = null, mov = null;
  try {
    r = await q(sb.from('recibos').select('*').eq('id', id).single());
    if (r.documento_id) fac = await sb.from('documentos').select('id, codigo').eq('id', r.documento_id).maybeSingle().then(x => x.data);
    if (r.movimiento_id) mov = await sb.from('movimientos').select('id, numero, ejercicio').eq('id', r.movimiento_id).maybeSingle().then(x => x.data);
  } catch (e) { return tostada(mensajeError(e), { error: true }); }
  const ed = puedeEditar();
  const d = dialogo({
    titulo: `Recibo ${r.codigo}`,
    cuerpo: `<div class="cabecera-doc"><span class="etiqueta">${r.tipo === 'pago' ? 'Pago' : 'Cobro'}</span>
        ${r.anulado ? '<span class="etiqueta etiqueta-error">Anulado</span>' : '<span class="etiqueta etiqueta-ok">Firmado</span>'}
        ${mov ? `<button type="button" class="btn btn-texto" data-ver-mov="${mov.id}">${ico('libro', 'ico-s')} Apunte nº ${mov.numero} del libro</button>` : ''}
        ${fac ? `<button type="button" class="btn btn-texto" data-ir-doc="${fac.id}">${ico('factura', 'ico-s')} Factura ${esc(fac.codigo)}</button>` : ''}</div>
      ${r.anulado ? `<div class="aviso aviso-error">${ico('anular')}<p><strong>Anulado.</strong> ${esc(r.motivo_anulacion || '')}</p></div>` : ''}
      ${!r.pdf_ruta && !r.anulado && ed ? `<div class="aviso aviso-aviso">${ico('alerta')}<p>El PDF firmado aún no está adjunto al apunte del libro.</p>
        <button type="button" class="btn btn-texto acciones" id="b-adjuntar">Adjuntar ahora</button></div>` : ''}
      <div class="acciones-doc">
        <button type="button" class="btn" id="b-pdf-rec">${ico('descargar')} Descargar PDF</button>
        ${navigator.share ? `<button type="button" class="btn" id="b-compartir-rec">${ico('compartir')} Compartir</button>` : ''}
      </div>
      <div id="rec-papel" aria-busy="true"><div class="esqueleto esq-bloque"></div></div>`,
    pie: ed && !r.anulado ? `<button type="button" class="btn btn-texto izquierda" id="b-anular-rec">${ico('anular')} Anular recibo</button>
      <button type="button" class="btn" data-cerrar>Cerrar</button>` : '<button type="button" class="btn" data-cerrar>Cerrar</button>',
  });
  papelRecibo(r).then(html => { const c = $('#rec-papel', d); if (c) { c.innerHTML = html; c.removeAttribute('aria-busy'); } });
  const nombre = `${r.codigo} ${slug(r.persona)}.pdf`;
  $('[data-ver-mov]', d)?.addEventListener('click', e => { d.close(); abrirDetalle(e.currentTarget.dataset.verMov); });
  $('[data-ir-doc]', d)?.addEventListener('click', e => { d.close(); abrirDocumento(e.currentTarget.dataset.irDoc); });
  $('#b-pdf-rec', d).addEventListener('click', e => conBoton(e.currentTarget, async () => {
    try { descargar(nombre, await generarPdfRecibo(r), 'application/pdf'); } catch (err) { tostada('No se pudo crear el PDF. ' + mensajeError(err), { error: true }); }
  }));
  $('#b-compartir-rec', d)?.addEventListener('click', e => conBoton(e.currentTarget, async () => {
    try {
      const archivo = new File([await generarPdfRecibo(r)], nombre, { type: 'application/pdf' });
      if (navigator.canShare?.({ files: [archivo] })) await navigator.share({ files: [archivo], title: `Recibo ${r.codigo}` });
      else { descargar(nombre, archivo, 'application/pdf'); tostada('Este navegador no permite compartir archivos: se ha descargado el PDF.'); }
    } catch (err) { if (err?.name !== 'AbortError') tostada(mensajeError(err), { error: true }); }
  }));
  $('#b-adjuntar', d)?.addEventListener('click', e => conBoton(e.currentTarget, async () => {
    try { await adjuntarPdfRecibo(r.id); d.close(); abrirRecibo(r.id); tostada('PDF adjuntado al apunte'); } catch (err) { tostada(mensajeError(err), { error: true }); }
  }));
  $('#b-anular-rec', d)?.addEventListener('click', async () => {
    const ok = await confirmar({
      titulo: `¿Anular el recibo ${r.codigo}?`, boton: 'Anular recibo', peligro: true, motivo: 'Motivo de la anulación',
      texto: r.documento_id ? 'El recibo quedará marcado como anulado. El cobro de la factura no cambia: si hace falta, deshazlo desde la factura.'
        : 'El recibo quedará marcado como anulado y su apunte del libro también se anulará. Si había un error, después haz un recibo nuevo.',
    });
    if (!ok) return;
    try {
      await q(sb.rpc('anular_recibo', { p_recibo: r.id, p_motivo: ok.motivo }));
      d.close(); if (location.hash.startsWith('#facturas')) enrutar(); tostada(`Recibo ${r.codigo} anulado`); abrirRecibo(r.id);
    } catch (err) { tostada(mensajeError(err), { error: true }); }
  });
}

// ======================================================================
// Subvenciones (tanda 4)
// ======================================================================
const ESTADOS_SUB = { solicitada: ['Solicitada', ''], concedida: ['Concedida', 'etiqueta-ok'], denegada: ['Denegada', 'etiqueta-error'], justificada: ['Justificada', 'etiqueta-ok'] };
const ORGANISMOS = ['Ayuntamiento de Mengíbar', 'Diputación Provincial de Jaén', 'Junta de Andalucía', 'Ministerio de Cultura'];
const diasHasta = iso => Math.round((new Date(iso + 'T12:00:00') - new Date(hoy() + 'T12:00:00')) / 864e5);
function avisoPlazo(s) {
  if (s.estado !== 'concedida' || !s.plazo_justificacion) return '';
  const d = diasHasta(s.plazo_justificacion);
  if (d < 0) return `<span class="etiqueta etiqueta-error">${ico('alerta', 'ico-s')} Plazo de justificación vencido</span>`;
  if (d <= 30) return `<span class="etiqueta etiqueta-aviso">${ico('alerta', 'ico-s')} Justificar ${d === 0 ? 'hoy' : `en ${d} ${d === 1 ? 'día' : 'días'}`}</span>`;
  return '';
}
const chipSub = s => `<span class="etiqueta ${ESTADOS_SUB[s.estado][1]}">${ESTADOS_SUB[s.estado][0]}</span>${avisoPlazo(s)}`;
function barra(valor, total, etiqueta) {
  const pct = total > 0 ? Math.min(100, Math.round((valor / total) * 100)) : 0;
  return `<div class="progreso"><div class="progreso-txt"><span class="muted pequeno">${etiqueta}</span>
      <span class="num"><strong>${eur(valor)}</strong>${total > 0 ? ` de ${eur(total)} (${pct} %)` : ''}</span></div>
    <div class="barra" role="progressbar" aria-label="${etiqueta}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}"><span style="width:${pct}%"></span></div></div>`;
}
async function datosSubvenciones() {
  const [cobros, gastos] = await Promise.all([
    q(sb.from('movimientos').select('id, subvencion_id, importe, fecha, numero, ejercicio, concepto, cuenta_id').not('subvencion_id', 'is', null).eq('anulado', false)),
    q(sb.from('subvencion_gastos').select('id, subvencion_id, importe, movimiento_id, movimientos(numero, ejercicio, fecha, concepto, tercero, importe, anulado, cuenta_id)')),
  ]);
  const cobrado = id => cobros.filter(c => c.subvencion_id === id).reduce((a, c) => a + Number(c.importe), 0);
  const justificado = id => gastos.filter(g => g.subvencion_id === id && !g.movimientos?.anulado).reduce((a, g) => a + Number(g.importe), 0);
  return { cobros, gastos, cobrado, justificado };
}

async function vistaSubvenciones() {
  const v = $('#vista');
  v.innerHTML = esqueleto(3);
  let subs, ex;
  try { [subs, ex] = await Promise.all([q(sb.from('subvenciones').select('*').eq('ejercicio', E.ejercicio).order('creado_en', { ascending: false })), datosSubvenciones()]); }
  catch (e) { return errorVista(v, e, vistaSubvenciones); }
  const vivas = subs.filter(s => ['concedida', 'justificada'].includes(s.estado));
  const tConc = vivas.reduce((a, s) => a + Number(s.concedido || 0), 0), tCob = subs.reduce((a, s) => a + ex.cobrado(s.id), 0);
  v.innerHTML = `
    <div class="encabezado-vista"><h1>Subvenciones ${E.ejercicio}</h1>
      ${puedeEditar() ? `<button type="button" class="btn btn-primario" data-sub-nueva>${ico('mas')} Nueva subvención</button>` : ''}</div>
    ${subs.length ? `<div class="resumen-libro"><span>Concedido <strong class="num">${eur(tConc)}</strong></span>
        <span>Cobrado <strong class="num">${eur(tCob)}</strong></span><span>Pendiente de cobro <strong class="num">${eur(Math.max(0, tConc - tCob))}</strong></span></div>
      <ul class="lista-apuntes">${subs.map(s => `<li><a class="fila" href="#subvencion?id=${s.id}">
        <span class="concepto">${esc(s.convocatoria)}</span>
        <span class="importe num">${s.concedido != null ? eur(s.concedido) : s.solicitado != null ? eur(s.solicitado) : '—'}</span>
        <span class="meta"><span>${esc(s.organismo)}</span>
          ${['concedida', 'justificada'].includes(s.estado) ? `<span>Cobrado ${eur(ex.cobrado(s.id))} · Justificado ${eur(ex.justificado(s.id))}</span>` : s.estado === 'solicitada' ? '<span>Importe solicitado</span>' : ''}
          ${chipSub(s)}</span></a></li>`).join('')}</ul>`
    : `<div class="vacio">${ico('subvencion')}<h2>No hay subvenciones de ${E.ejercicio}</h2>
        <p>Apunta cada subvención que solicitéis: la app os recordará el plazo de justificación y qué gastos la justifican.</p>
        ${puedeEditar() ? `<button type="button" class="btn btn-primario" data-sub-nueva>${ico('mas')} Añadir la primera</button>` : ''}</div>`}`;
  $$('[data-sub-nueva]', v).forEach(b => b.addEventListener('click', () => formSubvencion()));
}

function formSubvencion(s = null) {
  const campoFecha = (id, et, val) => `<div class="campo"><label for="s-${id}">${et}</label><input id="s-${id}" type="date" value="${val || ''}"></div>`;
  const campoImporte = (id, et, val, ayuda) => `<div class="campo"><label for="s-${id}">${et}</label>
    <input id="s-${id}" inputmode="decimal" class="num" placeholder="0,00" value="${val != null ? numInput(val) : ''}" aria-describedby="s-${id}-err${ayuda ? ` s-${id}-ayuda` : ''}">
    ${ayuda ? `<p class="ayuda" id="s-${id}-ayuda">${ayuda}</p>` : ''}<p class="error" id="s-${id}-err" hidden></p></div>`;
  const d = dialogo({
    titulo: s ? 'Editar subvención' : 'Nueva subvención', cerrarFuera: false,
    cuerpo: `<form class="formulario" id="f-sub" novalidate>
      <div class="campo"><label for="s-organismo">Organismo</label>
        <input id="s-organismo" list="dl-organismos" required maxlength="120" autocomplete="off" value="${esc(s?.organismo || '')}" placeholder="Ej.: Ayuntamiento de Mengíbar" aria-describedby="s-organismo-err">
        <datalist id="dl-organismos">${ORGANISMOS.map(o => `<option value="${esc(o)}"></option>`).join('')}</datalist><p class="error" id="s-organismo-err" hidden></p></div>
      <div class="campo"><label for="s-convocatoria">Convocatoria o nombre</label>
        <input id="s-convocatoria" required maxlength="200" autocomplete="off" value="${esc(s?.convocatoria || '')}" placeholder="Ej.: Subvenciones a asociaciones culturales 2027" aria-describedby="s-convocatoria-err"><p class="error" id="s-convocatoria-err" hidden></p></div>
      <div class="fila-campos">
        <div class="campo"><label for="s-ejercicio">Año</label><input id="s-ejercicio" type="number" inputmode="numeric" min="2000" max="2100" required value="${s?.ejercicio || E.ejercicio}"></div>
        <div class="campo"><label for="s-estado">Estado</label><select id="s-estado">${Object.entries(ESTADOS_SUB).map(([k, [t]]) => `<option value="${k}" ${(s?.estado || 'solicitada') === k ? 'selected' : ''}>${t}</option>`).join('')}</select></div>
      </div>
      <div class="fila-campos">${campoImporte('solicitado', 'Importe solicitado (€)', s?.solicitado)}${campoImporte('concedido', 'Importe concedido (€)', s?.concedido, 'Cuando os lo comuniquen.')}</div>
      <div class="fila-campos">${campoFecha('fecha_solicitud', 'Fecha de solicitud', s?.fecha_solicitud)}${campoFecha('fecha_resolucion', 'Fecha de resolución', s?.fecha_resolucion)}</div>
      <div class="fila-campos">${campoFecha('plazo_justificacion', 'Plazo de justificación', s?.plazo_justificacion)}${campoFecha('fecha_justificada', 'Justificada el', s?.fecha_justificada)}</div>
      <div class="campo"><label for="s-notas">Notas</label><textarea id="s-notas" maxlength="1000" aria-describedby="s-notas-ayuda">${esc(s?.notas || '')}</textarea>
        <p class="ayuda" id="s-notas-ayuda">Opcional. Por ejemplo, qué gastos admite o a quién hay que entregar la justificación.</p></div>
      <div class="aviso aviso-error" id="s-error" role="alert" hidden></div></form>`,
    pie: `${s ? `<button type="button" class="btn btn-texto izquierda" id="b-sub-borrar">${ico('papelera', 'ico-s')} Borrar</button>` : ''}
      <button type="button" class="btn" data-cerrar>Cancelar</button><button type="submit" form="f-sub" class="btn btn-primario">${s ? 'Guardar cambios' : 'Guardar subvención'}</button>`,
  });
  const f = $('#f-sub', d);
  $('#s-estado', f).addEventListener('change', e => { if (e.target.value === 'justificada' && !$('#s-fecha_justificada', f).value) $('#s-fecha_justificada', f).value = hoy(); });
  f.addEventListener('submit', async e => {
    e.preventDefault();
    const org = $('#s-organismo', f), conv = $('#s-convocatoria', f);
    mostrarError(org, org.value.trim() ? '' : 'Escribe el organismo que la convoca.');
    mostrarError(conv, conv.value.trim() ? '' : 'Escribe el nombre de la convocatoria.');
    const importe = id => { const el = $(`#s-${id}`, f), n = el.value.trim() ? parseImporte(el.value) : null; mostrarError(el, n !== null && !(n >= 0) ? 'Escribe el importe con números, por ejemplo 2.000,00.' : ''); return n; };
    const datos = {
      organismo: org.value.trim(), convocatoria: conv.value.trim(), ejercicio: Number($('#s-ejercicio', f).value), estado: $('#s-estado', f).value,
      solicitado: importe('solicitado'), concedido: importe('concedido'), notas: $('#s-notas', f).value.trim() || null,
      ...Object.fromEntries(['fecha_solicitud', 'fecha_resolucion', 'plazo_justificacion', 'fecha_justificada'].map(k => [k, $(`#s-${k}`, f).value || null])),
    };
    const malo = f.querySelector('[aria-invalid="true"]'); if (malo) return malo.focus();
    if (!(datos.ejercicio >= 2000 && datos.ejercicio <= 2100)) { tostada('Revisa el año.', { error: true }); return $('#s-ejercicio', f).focus(); }
    await conBoton(d.querySelector('[type=submit]'), async () => {
      try {
        const res = s ? await q(sb.from('subvenciones').update(datos).eq('id', s.id).select().single()) : await q(sb.from('subvenciones').insert(datos).select().single());
        d.close(); tostada(s ? 'Subvención actualizada' : 'Subvención guardada'); irA(`subvencion?id=${res.id}`);
      } catch (err) { const box = $('#s-error', f); box.innerHTML = `${ico('alerta')}<p>${esc(mensajeError(err))}</p>`; box.hidden = false; }
    });
  });
  $('#b-sub-borrar', d)?.addEventListener('click', async () => {
    if (!await confirmar({ titulo: '¿Borrar esta subvención?', texto: 'Se borrará la ficha con sus gastos asignados y documentos. Los apuntes del libro no se tocan. Si ya tiene cobros, primero desenlázalos.', boton: 'Borrar subvención', peligro: true })) return;
    try {
      const docs = await q(sb.from('subvencion_documentos').select('ruta').eq('subvencion_id', s.id));
      await q(sb.from('subvenciones').delete().eq('id', s.id));
      if (docs.length) await sb.storage.from('justificantes').remove(docs.map(x => x.ruta));
      d.close(); tostada('Subvención borrada'); irA('subvenciones');
    } catch (err) {
      tostada(err?.code === '23503' ? 'Tiene cobros enlazados en el libro: desenlázalos primero desde la ficha.' : mensajeError(err), { error: true });
    }
  });
  setTimeout(() => $('#s-organismo', f).focus(), 50);
}

async function vistaSubvencion(params) {
  const id = params.get('id'), v = $('#vista');
  v.innerHTML = esqueleto(5);
  let s, ex, docs;
  try {
    [s, ex, docs] = await Promise.all([q(sb.from('subvenciones').select('*').eq('id', id).single()), datosSubvenciones(),
      q(sb.from('subvencion_documentos').select('*').eq('subvencion_id', id).order('subido_en'))]);
  } catch (e) { return errorVista(v, e, () => vistaSubvencion(params)); }
  const cobros = ex.cobros.filter(c => c.subvencion_id === id).sort((a, b) => a.fecha.localeCompare(b.fecha));
  const gastos = ex.gastos.filter(g => g.subvencion_id === id).sort((a, b) => a.movimientos.fecha.localeCompare(b.movimientos.fecha));
  const concedido = Number(s.concedido || 0), tCob = ex.cobrado(id), tJus = ex.justificado(id);
  const ed = puedeEditar();
  const fechas = [['Solicitada el', s.fecha_solicitud], ['Resolución', s.fecha_resolucion], ['Plazo de justificación', s.plazo_justificacion], ['Justificada el', s.fecha_justificada]].filter(x => x[1]);
  v.innerHTML = `
    <div class="encabezado-vista"><a class="btn btn-texto" href="#subvenciones">← Subvenciones</a></div>
    <div class="encabezado-vista"><h1>${esc(s.convocatoria)}</h1>${ed ? `<button type="button" class="btn" id="b-sub-editar">${ico('lapiz')} Editar</button>` : ''}</div>
    <p class="muted">${esc(s.organismo)} · ${s.ejercicio}</p>
    <div class="cabecera-doc" style="margin-top:var(--space-2)">${chipSub(s)}</div>
    <div class="rejilla rejilla-3 seccion">
      <section class="tarjeta kpi"><span class="muted pequeno">Concedido</span><span class="cifra num">${s.concedido != null ? eur(s.concedido) : '—'}</span>
        <span class="muted pequeno">Solicitado: ${s.solicitado != null ? eur(s.solicitado) : '—'}</span></section>
      <section class="tarjeta">${barra(tCob, concedido, 'Cobrado')}</section>
      <section class="tarjeta">${barra(tJus, concedido, 'Justificado con gastos')}</section>
    </div>
    ${fechas.length || s.notas ? `<dl class="datos seccion">${fechas.map(([t, f]) => `<dt>${t}</dt><dd>${fecha(f)}</dd>`).join('')}${s.notas ? `<dt>Notas</dt><dd>${esc(s.notas)}</dd>` : ''}</dl>` : ''}

    <section class="seccion" aria-labelledby="t-cobros"><div class="encabezado-vista"><h2 id="t-cobros">Cobros</h2>
      ${ed && s.estado !== 'denegada' ? `<button type="button" class="btn btn-texto" id="b-sub-enlazar">Enlazar un ingreso ya apuntado</button>
        <button type="button" class="btn" id="b-sub-cobro">${ico('caja')} Registrar cobro</button>` : ''}</div>
      ${cobros.length ? `<ul class="lista-apuntes">${cobros.map(c => `<li class="fila-con-accion"><button type="button" class="fila" data-mov="${c.id}">
          <span class="concepto">${esc(c.concepto)}</span><span class="importe num positivo">+${eur(c.importe)}</span>
          <span class="meta"><span class="num">Nº ${c.numero}/${c.ejercicio}</span><span>${fecha(c.fecha)}</span><span>${esc(cuenta(c.cuenta_id)?.nombre || '')}</span></span></button>
          ${ed ? `<button type="button" class="btn btn-icono" data-desenlazar="${c.id}" aria-label="Desenlazar este ingreso de la subvención">${ico('x', 'ico-s')}</button>` : ''}</li>`).join('')}</ul>`
        : '<p class="muted">Aún no se ha cobrado nada de esta subvención.</p>'}
    </section>

    <section class="seccion" aria-labelledby="t-gastos"><div class="encabezado-vista"><h2 id="t-gastos">Gastos que la justifican</h2>
      ${gastos.length ? `<button type="button" class="btn btn-texto" id="b-sub-csv">${ico('descargar', 'ico-s')} Excel</button>
        <button type="button" class="btn btn-texto" id="b-sub-pdf">${ico('descargar', 'ico-s')} Relación en PDF</button>` : ''}
      ${ed ? `<button type="button" class="btn" id="b-sub-gastos">${ico('mas')} Añadir gastos</button>` : ''}</div>
      ${concedido > 0 && tJus < concedido && s.estado === 'concedida' ? `<p class="muted pequeno" style="margin-bottom:var(--space-2)">Faltan <strong class="num">${eur(concedido - tJus)}</strong> por justificar.</p>` : ''}
      ${gastos.length ? `<ul class="lista-apuntes">${gastos.map(g => { const m = g.movimientos; return `<li class="fila-con-accion">
          <button type="button" class="fila ${m.anulado ? 'anulada' : ''}" data-mov="${g.movimiento_id}">
            <span class="concepto">${esc(m.concepto)}</span><span class="importe num">${eur(g.importe)}</span>
            <span class="meta"><span class="num">Nº ${m.numero}/${m.ejercicio}</span><span>${fecha(m.fecha)}</span>${m.tercero ? `<span>${esc(m.tercero)}</span>` : ''}
              ${Number(g.importe) < Number(m.importe) ? `<span>Parte de un gasto de ${eur(m.importe)}</span>` : ''}${m.anulado ? '<span class="etiqueta etiqueta-error">Gasto anulado: no cuenta</span>' : ''}</span></button>
          ${ed ? `<button type="button" class="btn btn-icono" data-quitar-gasto="${g.id}" aria-label="Quitar este gasto de la subvención">${ico('x', 'ico-s')}</button>` : ''}</li>`; }).join('')}</ul>`
        : '<p class="muted">Añade los gastos del libro que justifican esta subvención: músicos, partituras, desplazamientos…</p>'}
    </section>

    <section class="seccion" aria-labelledby="t-docs"><div class="encabezado-vista"><h2 id="t-docs">Documentos</h2>
      ${ed ? `<label class="btn" for="sd-archivo">${ico('clip')} Añadir documento</label><input type="file" id="sd-archivo" class="sr" accept="image/*,application/pdf" multiple>` : ''}</div>
      ${docs.length ? `<ul class="lista-simple">${docs.map(x => `<li>${ico(x.tipo_mime === 'application/pdf' ? 'archivo' : 'camara', 'ico-s')}
          <span class="crece">${esc(x.nombre)}<br><span class="muted pequeno">${fecha(x.subido_en)}</span></span>
          <button type="button" class="btn btn-texto" data-ver-doc="${x.id}">Ver</button>
          ${ed ? `<button type="button" class="btn btn-icono" data-quitar-doc="${x.id}" aria-label="Quitar ${esc(x.nombre)}">${ico('papelera', 'ico-s')}</button>` : ''}</li>`).join('')}</ul>`
        : '<p class="muted">Guarda aquí las bases, la resolución y la justificación entregada.</p>'}
      <p class="archivos-elegidos" id="sd-estado" role="status"></p>
    </section>`;

  const recargar = () => vistaSubvencion(params);
  $('#b-sub-editar')?.addEventListener('click', () => formSubvencion(s));
  $('#b-sub-cobro')?.addEventListener('click', () => formCobroSubvencion(s, Math.max(0, concedido - tCob), recargar));
  $('#b-sub-enlazar')?.addEventListener('click', () => enlazarIngreso(s, recargar));
  $('#b-sub-gastos')?.addEventListener('click', () => asignarGastos(s, ex, recargar));
  $$('[data-desenlazar]', v).forEach(b => b.addEventListener('click', async () => {
    try {
      await q(sb.from('movimientos').update({ subvencion_id: null }).eq('id', b.dataset.desenlazar));
      recargar(); tostada('Ingreso desenlazado. Sigue en el libro.', { deshacer: async () => { await q(sb.from('movimientos').update({ subvencion_id: s.id }).eq('id', b.dataset.desenlazar)); recargar(); } });
    } catch (err) { tostada(mensajeError(err), { error: true }); }
  }));
  $$('[data-quitar-gasto]', v).forEach(b => b.addEventListener('click', async () => {
    const g = gastos.find(x => x.id === b.dataset.quitarGasto);
    try {
      await q(sb.from('subvencion_gastos').delete().eq('id', g.id));
      recargar(); tostada('Gasto quitado de la subvención', { deshacer: async () => { await q(sb.from('subvencion_gastos').insert({ subvencion_id: s.id, movimiento_id: g.movimiento_id, importe: g.importe })); recargar(); } });
    } catch (err) { tostada(mensajeError(err), { error: true }); }
  }));
  $$('[data-ver-doc]', v).forEach(b => b.addEventListener('click', async () => {
    const x = docs.find(y => y.id === b.dataset.verDoc), ventana = window.open('', '_blank');
    try { const { signedUrl } = await q(sb.storage.from('justificantes').createSignedUrl(x.ruta, 300)); if (ventana) ventana.location = signedUrl; else location.href = signedUrl; }
    catch (err) { ventana?.close(); tostada(mensajeError(err), { error: true }); }
  }));
  $$('[data-quitar-doc]', v).forEach(b => b.addEventListener('click', async () => {
    const x = docs.find(y => y.id === b.dataset.quitarDoc);
    if (!await confirmar({ titulo: '¿Quitar este documento?', texto: `Se borrará «${esc(x.nombre)}».`, boton: 'Quitar documento', peligro: true })) return;
    try { await q(sb.from('subvencion_documentos').delete().eq('id', x.id)); await sb.storage.from('justificantes').remove([x.ruta]); recargar(); tostada('Documento quitado'); }
    catch (err) { tostada(mensajeError(err), { error: true }); }
  }));
  $('#sd-archivo')?.addEventListener('change', async e => {
    const archivos = [...e.target.files]; e.target.value = '';
    $('#sd-estado').textContent = archivos.length === 1 ? 'Subiendo el documento…' : `Subiendo ${archivos.length} documentos…`;
    try {
      for (const a of archivos) {
        let blob = a, nombre = a.name || 'documento', tipo = a.type;
        if (tipo.startsWith('image/')) { blob = await comprimirImagen(a); tipo = 'image/jpeg'; nombre = nombre.replace(/\.[^.]+$/, '') + '.jpg'; }
        else if (tipo !== 'application/pdf') throw new ErrorHumano(`«${nombre}» no es una foto ni un PDF.`);
        if (blob.size > 10 * 1024 * 1024) throw new ErrorHumano(`«${nombre}» ocupa más de 10 MB.`);
        const ruta = `subvenciones/${s.id}/${crypto.randomUUID().slice(0, 8)}-${slug(nombre)}`;
        await q(sb.storage.from('justificantes').upload(ruta, blob, { contentType: tipo }));
        try { await q(sb.from('subvencion_documentos').insert({ subvencion_id: s.id, ruta, nombre, tipo_mime: tipo, tamano: blob.size })); }
        catch (err) { await sb.storage.from('justificantes').remove([ruta]); throw err; }
      }
      recargar(); tostada(archivos.length === 1 ? 'Documento guardado' : 'Documentos guardados');
    } catch (err) { $('#sd-estado').textContent = ''; tostada(mensajeError(err), { error: true }); }
  });
  const filasRelacion = () => gastos.filter(g => !g.movimientos.anulado).map(g => ({ ...g.movimientos, imputado: Number(g.importe) }));
  $('#b-sub-csv')?.addEventListener('click', () => {
    const filas = filasRelacion().map(m => [`${m.numero}/${m.ejercicio}`, m.fecha.split('-').reverse().join('/'), m.tercero || '', m.concepto, csvNum(m.importe), csvNum(m.imputado)]);
    const total = filasRelacion().reduce((a, m) => a + m.imputado, 0);
    descargar(`justificacion-${slug(s.convocatoria)}.csv`, csv([[`${s.convocatoria} · ${s.organismo}`], ['Nº apunte', 'Fecha', 'Proveedor o perceptor', 'Concepto', 'Importe del gasto', 'Importe imputado'], ...filas, ['', '', '', 'TOTAL', '', csvNum(total)]]), 'text/csv;charset=utf-8');
  });
  $('#b-sub-pdf')?.addEventListener('click', e => conBoton(e.currentTarget, async () => {
    try { descargar(`justificacion-${slug(s.convocatoria)}.pdf`, await pdfRelacionGastos(s, filasRelacion(), tCob), 'application/pdf'); }
    catch (err) { tostada('No se pudo crear el PDF. ' + mensajeError(err), { error: true }); }
  }));
}

function formCobroSubvencion(s, pendiente, alTerminar) {
  const activas = E.cuentas.filter(c => c.activa), cats = E.categorias.filter(c => c.tipo === 'ingreso' && c.activa);
  const catDef = (cats.find(c => /subvenci/i.test(c.nombre)) || cats[0])?.id;
  const d = dialogo({
    titulo: 'Registrar cobro de la subvención', cerrarFuera: false,
    cuerpo: `<form class="formulario" id="f-cs" novalidate>
      <p>Se apuntará en el libro un ingreso de ${esc(s.organismo)} enlazado a esta subvención. Si os la pagan en varias veces, registra cada pago por separado.</p>
      <div class="fila-campos">
        <div class="campo"><label for="cs-importe">Importe (€)</label><input id="cs-importe" class="input-importe" inputmode="decimal" value="${pendiente > 0 ? numInput(pendiente) : ''}" placeholder="0,00" aria-describedby="cs-importe-err"><p class="error" id="cs-importe-err" hidden></p></div>
        <div class="campo"><label for="cs-fecha">Fecha del cobro</label><input id="cs-fecha" type="date" value="${hoy()}"></div>
      </div>
      <div class="fila-campos">
        <div class="campo"><label for="cs-cuenta">Cobrado en</label><select id="cs-cuenta">${activas.map(c => `<option value="${c.id}" ${c.tipo === 'banco' ? 'selected' : ''}>${esc(c.nombre)}</option>`).join('')}</select></div>
        <div class="campo"><label for="cs-cat">Categoría</label><select id="cs-cat">${cats.map(c => `<option value="${c.id}" ${c.id === catDef ? 'selected' : ''}>${esc(c.nombre)}</option>`).join('')}</select></div>
      </div>
      <div class="aviso aviso-error" id="cs-error" role="alert" hidden></div></form>`,
    pie: `<button type="button" class="btn" data-cerrar>Cancelar</button><button type="submit" form="f-cs" class="btn btn-primario">Registrar cobro</button>`,
  });
  $('#f-cs', d).addEventListener('submit', async e => {
    e.preventDefault();
    const imp = $('#cs-importe', d), n = parseImporte(imp.value);
    mostrarError(imp, n > 0 ? '' : 'Escribe un importe mayor que cero.');
    if (!(n > 0)) return imp.focus();
    await conBoton(d.querySelector('[type=submit]'), async () => {
      try {
        const mov = await q(sb.from('movimientos').insert({ tipo: 'ingreso', fecha: $('#cs-fecha', d).value, importe: n, concepto: `Subvención: ${s.convocatoria}`,
          tercero: s.organismo, categoria_id: $('#cs-cat', d).value, cuenta_id: $('#cs-cuenta', d).value, subvencion_id: s.id }).select().single());
        d.close(); alTerminar();
        tostada(`Cobro apuntado en el libro (nº ${mov.numero})`, { deshacer: async () => { await q(sb.from('movimientos').update({ anulado: true, motivo_anulacion: 'Cobro de subvención deshecho' }).eq('id', mov.id)); alTerminar(); } });
      } catch (err) { const box = $('#cs-error', d); box.innerHTML = `${ico('alerta')}<p>${esc(mensajeError(err))}</p>`; box.hidden = false; }
    });
  });
}

async function enlazarIngreso(s, alTerminar) {
  let ingresos;
  try {
    ingresos = await q(sb.from('movimientos').select('id, numero, ejercicio, fecha, concepto, tercero, importe').eq('tipo', 'ingreso').eq('anulado', false)
      .is('subvencion_id', null).in('ejercicio', [s.ejercicio, s.ejercicio + 1]).order('fecha', { ascending: false }));
  } catch (e) { return tostada(mensajeError(e), { error: true }); }
  const d = dialogo({
    titulo: 'Enlazar un ingreso ya apuntado',
    cuerpo: ingresos.length ? `<p style="margin-bottom:var(--space-3)">Elige el ingreso del libro que corresponde a esta subvención.</p>
      <ul class="lista-apuntes">${ingresos.map(m => `<li><button type="button" class="fila" data-enlazar="${m.id}">
        <span class="concepto">${esc(m.concepto)}</span><span class="importe num positivo">+${eur(m.importe)}</span>
        <span class="meta"><span class="num">Nº ${m.numero}/${m.ejercicio}</span><span>${fecha(m.fecha)}</span>${m.tercero ? `<span>${esc(m.tercero)}</span>` : ''}</span></button></li>`).join('')}</ul>`
      : `<div class="vacio">${ico('libro')}<p>No hay ingresos de ${s.ejercicio} o ${s.ejercicio + 1} sin enlazar. Usa «Registrar cobro» para apuntarlo.</p></div>`,
  });
  $$('[data-enlazar]', d).forEach(b => b.addEventListener('click', async () => {
    try { await q(sb.from('movimientos').update({ subvencion_id: s.id }).eq('id', b.dataset.enlazar)); d.close(); alTerminar(); tostada('Ingreso enlazado a la subvención'); }
    catch (err) { tostada(mensajeError(err), { error: true }); }
  }));
}

async function asignarGastos(s, ex, alTerminar) {
  let gastos;
  try {
    gastos = await q(sb.from('movimientos').select('id, numero, ejercicio, fecha, concepto, tercero, importe, categoria_id').eq('tipo', 'gasto').eq('anulado', false)
      .in('ejercicio', [s.ejercicio, s.ejercicio + 1]).order('fecha', { ascending: false }));
  } catch (e) { return tostada(mensajeError(e), { error: true }); }
  const yaAqui = new Set(ex.gastos.filter(g => g.subvencion_id === s.id).map(g => g.movimiento_id));
  const asignado = id => ex.gastos.filter(g => g.movimiento_id === id && g.subvencion_id !== s.id).reduce((a, g) => a + Number(g.importe), 0);
  const filas = gastos.filter(m => !yaAqui.has(m.id)).map(m => ({ ...m, libre: redondear(Number(m.importe) - asignado(m.id)) }));
  const falta = Math.max(0, Number(s.concedido || 0) - ex.justificado(s.id));
  const d = dialogo({
    titulo: 'Añadir gastos a la subvención', cerrarFuera: false,
    cuerpo: filas.length ? `<form class="formulario" id="f-ag" novalidate>
      <div class="campo"><label for="ag-q">Buscar</label><input id="ag-q" type="search" autocomplete="off" placeholder="Concepto, proveedor o nº"></div>
      <p class="pequeno" id="ag-total" aria-live="polite"></p>
      <ul class="lista-asignar">${filas.map(m => `<li data-texto="${esc(`${m.numero} ${m.concepto} ${m.tercero || ''} ${categoria(m.categoria_id)?.nombre || ''}`.toLowerCase())}">
        <label class="casilla"><input type="checkbox" data-gasto="${m.id}" ${m.libre <= 0 ? 'disabled' : ''}>
          <span><strong>${esc(m.concepto)}</strong><br><span class="muted pequeno">Nº ${m.numero}/${m.ejercicio} · ${fecha(m.fecha)}${m.tercero ? ` · ${esc(m.tercero)}` : ''} · ${eur(m.importe)}
            ${m.libre < Number(m.importe) ? (m.libre > 0 ? ` · libres ${eur(m.libre)} (el resto está en otra subvención)` : ' · ya asignado entero a otra subvención') : ''}</span></span></label>
        <div class="campo importe-asignar"><label class="sr" for="ag-i-${m.id}">Importe a asignar</label>
          <input id="ag-i-${m.id}" inputmode="decimal" class="num" value="${m.libre > 0 ? numInput(m.libre) : ''}" ${m.libre <= 0 ? 'disabled' : ''}></div></li>`).join('')}</ul>
      <div class="aviso aviso-error" id="ag-error" role="alert" hidden></div></form>`
      : `<div class="vacio">${ico('libro')}<p>No hay gastos de ${s.ejercicio} o ${s.ejercicio + 1} disponibles. Apunta primero los gastos en el libro.</p></div>`,
    pie: filas.length ? `<button type="button" class="btn" data-cerrar>Cancelar</button><button type="submit" form="f-ag" class="btn btn-primario">Añadir los marcados</button>` : '<button type="button" class="btn" data-cerrar>Cerrar</button>',
  });
  const f = $('#f-ag', d); if (!f) return;
  const total = () => {
    const t = $$('[data-gasto]:checked', f).reduce((a, c) => a + (parseImporte($(`#ag-i-${c.dataset.gasto}`, f).value) || 0), 0);
    $('#ag-total', f).innerHTML = `Marcado: <strong class="num">${eur(t)}</strong>${falta > 0 ? ` · faltaban <span class="num">${eur(falta)}</span> por justificar` : ''}`;
  };
  f.addEventListener('input', e => {
    if (e.target.id === 'ag-q') { const t = e.target.value.trim().toLowerCase(); $$('.lista-asignar li', f).forEach(li => { li.hidden = t && !li.dataset.texto.includes(t); }); }
    total();
  });
  f.addEventListener('change', total); total();
  f.addEventListener('submit', async e => {
    e.preventDefault();
    const marcados = $$('[data-gasto]:checked', f).map(c => ({ movimiento_id: c.dataset.gasto, importe: parseImporte($(`#ag-i-${c.dataset.gasto}`, f).value), libre: filas.find(m => m.id === c.dataset.gasto).libre }));
    const caja = $('#ag-error', f);
    const malo = marcados.find(m => !(m.importe > 0) || m.importe > m.libre);
    if (!marcados.length || malo) { caja.innerHTML = `${ico('alerta')}<p>${!marcados.length ? 'Marca al menos un gasto.' : `Revisa los importes: cada uno debe ser mayor que cero y no superar lo que queda libre del gasto.`}</p>`; caja.hidden = false; return; }
    await conBoton(d.querySelector('[type=submit]'), async () => {
      try {
        await q(sb.from('subvencion_gastos').insert(marcados.map(m => ({ subvencion_id: s.id, movimiento_id: m.movimiento_id, importe: m.importe }))));
        d.close(); alTerminar(); tostada(marcados.length === 1 ? 'Gasto añadido a la subvención' : `${marcados.length} gastos añadidos a la subvención`);
      } catch (err) { caja.innerHTML = `${ico('alerta')}<p>${esc(mensajeError(err))}</p>`; caja.hidden = false; }
    });
  });
}

// ---------- PDF: utilidades comunes para listados ----------
async function nuevoPdfListado(titulo, subtitulo) {
  if (!moduloPdf) moduloPdf = await import('https://cdn.jsdelivr.net/npm/jspdf@2.5.2/+esm');
  const JsPDF = moduloPdf.jsPDF || moduloPdf.default;
  const aj = E.ajustes || {};
  const pdf = new JsPDF({ unit: 'mm', format: 'a4' });
  const M = 16, AN = 210, AL = 297, ancho = AN - 2 * M;
  const TINTA = [29, 29, 27], GRIS = [97, 97, 92], AZUL = [17, 48, 85], LINEA = [220, 220, 214];
  const limpio = s => String(s ?? '').replace(/[  ]/g, ' ').replace(/−/g, '-');
  const txt = (t, x, y, o = {}) => { pdf.setFont('helvetica', o.b ? 'bold' : 'normal'); pdf.setFontSize(o.s || 9.5); pdf.setTextColor(...(o.c || TINTA)); pdf.text(limpio(t), x, y, { align: o.a || 'left' }); };
  const c = { pdf, M, AN, AL, ancho, y: M, txt, limpio, GRIS, AZUL };
  let xDatos = M;
  try { const logo = await logoActual(); if (logo) { const h = 14, w = Math.min(30, h * logo.ratio); pdf.addImage(logo.data, logo.formato, M, M, w, h, undefined, 'FAST'); xDatos = M + w + 5; } } catch {}
  txt(aj.nombre || '', xDatos, M + 5, { b: true, s: 11 });
  if (aj.cif) txt(`CIF ${aj.cif}`, xDatos, M + 10, { s: 8.5, c: GRIS });
  c.y = M + 24;
  txt(titulo, M, c.y, { b: true, s: 15, c: AZUL }); c.y += 6;
  if (subtitulo) { pdf.setFontSize(9.5); pdf.splitTextToSize(limpio(subtitulo), ancho).forEach(l => { txt(l, M, c.y, { c: GRIS }); c.y += 4.6; }); }
  c.y += 4;
  c.saltoSi = alto => { if (c.y + alto > AL - 18) { pdf.addPage(); c.y = M; return true; } return false; };
  c.seccion = t => { c.saltoSi(20); c.y += 3; txt(t, M, c.y, { b: true, s: 11.5 }); c.y += 5; };
  c.parrafo = (t, o = {}) => { pdf.setFontSize(o.s || 9.5); pdf.splitTextToSize(limpio(t), ancho).forEach(l => { c.saltoSi(6); txt(l, M, c.y, o); c.y += (o.s || 9.5) * 0.48; }); c.y += 2; };
  // Tabla: columnas [{t: título, w: ancho mm, a: 'left'|'right'}], filas de textos; la última fila puede ir en negrita
  c.tabla = (cols, filas, { totalUltima = false } = {}) => {
    const cab = () => {
      pdf.setFillColor(...AZUL); pdf.rect(M, c.y, ancho, 7, 'F');
      let x = M; cols.forEach(col => { txt(col.t, col.a === 'right' ? x + col.w - 2 : x + 2, c.y + 4.8, { s: 8.5, b: true, c: [255, 255, 255], a: col.a }); x += col.w; });
      c.y += 7;
    };
    c.saltoSi(7 + 9 * Math.min(filas.length, 2));   // la cabecera nunca se queda sola al final de una página
    cab();
    filas.forEach((f, i) => {
      const ult = totalUltima && i === filas.length - 1;
      pdf.setFontSize(9);
      const partes = f.map((v, j) => pdf.splitTextToSize(limpio(v), cols[j].w - 4));
      const alto = 3 + Math.max(...partes.map(p => p.length)) * 4.2;
      if (c.saltoSi(alto + 2)) cab();
      let x = M;
      partes.forEach((p, j) => { p.forEach((l, k) => txt(l, cols[j].a === 'right' ? x + cols[j].w - 2 : x + 2, c.y + 4.6 + k * 4.2, { s: 9, b: ult, a: cols[j].a })); x += cols[j].w; });
      c.y += alto; pdf.setDrawColor(...(ult ? AZUL : LINEA)); pdf.line(M, c.y, M + ancho, c.y);
    });
    c.y += 4;
  };
  c.cerrar = () => {
    const n = pdf.getNumberOfPages();
    for (let i = 1; i <= n; i++) { pdf.setPage(i); txt(`${aj.nombre || ''} · ${titulo}`, M, AL - 8, { s: 7.5, c: GRIS }); txt(`Página ${i} de ${n}`, AN - M, AL - 8, { s: 7.5, c: GRIS, a: 'right' }); }
    return pdf.output('blob');
  };
  return c;
}

async function pdfRelacionGastos(s, filas, cobrado) {
  const total = filas.reduce((a, m) => a + m.imputado, 0);
  const c = await nuevoPdfListado('Relación de gastos justificativos',
    `${s.convocatoria} · ${s.organismo} · ${s.ejercicio}. Concedido: ${s.concedido != null ? eur(s.concedido) : '—'}. Cobrado: ${eur(cobrado)}. Total justificado: ${eur(total)}.`);
  c.tabla([{ t: 'Nº', w: 18 }, { t: 'Fecha', w: 22 }, { t: 'Proveedor o perceptor', w: 42 }, { t: 'Concepto', w: 56 }, { t: 'Gasto', w: 20, a: 'right' }, { t: 'Imputado', w: 20, a: 'right' }],
    [...filas.map(m => [`${m.numero}/${m.ejercicio}`, fecha(m.fecha), m.tercero || '', m.concepto, eur(m.importe), eur(m.imputado)]), ['', '', '', 'TOTAL', '', eur(total)]], { totalUltima: true });
  c.parrafo(`Documento generado el ${fechaLarga(hoy())}. Los justificantes de cada gasto están en el libro de la coral con el número de apunte indicado.`, { s: 8.5, c: c.GRIS });
  return c.cerrar();
}

// ======================================================================
// Memoria económica anual (tanda 4)
// ======================================================================
async function datosMemoria(anio) {
  const [movs, movsAnt, subs, ex, docs, memo, presActual, presSig] = await Promise.all([
    q(sb.from('movimientos').select('tipo, importe, categoria_id').eq('ejercicio', anio).eq('anulado', false).limit(50000)),
    q(sb.from('movimientos').select('tipo, importe, categoria_id').eq('ejercicio', anio - 1).eq('anulado', false).limit(50000)),
    q(sb.from('subvenciones').select('*').eq('ejercicio', anio).order('organismo')),
    datosSubvenciones(),
    q(sb.from('documentos').select('tipo, estado, total').eq('ejercicio', anio).neq('tipo', 'presupuesto')),
    q(sb.from('memorias').select('*').eq('ejercicio', anio).maybeSingle()),
    q(sb.from('presupuesto_lineas').select('categoria_id, importe').eq('ejercicio', anio)),
    q(sb.from('presupuesto_lineas').select('categoria_id, importe').eq('ejercicio', anio + 1)),
  ]);
  const finAnt = `${anio - 1}-12-31`, fin = `${anio}-12-31`;
  const cuentas = E.cuentas.filter(c => c.fecha_inicial <= fin);
  const saldos = await Promise.all(cuentas.map(async c => ({
    nombre: c.nombre,
    inicio: c.fecha_inicial > finAnt ? Number(c.saldo_inicial) : Number(await q(sb.rpc('saldo_a_fecha', { p_cuenta: c.id, p_fecha: finAnt }))),
    abierta: c.fecha_inicial > finAnt ? c.fecha_inicial : null,
    fin: Number(await q(sb.rpc('saldo_a_fecha', { p_cuenta: c.id, p_fecha: fin }))),
  })));
  const porCategoria = (lista, tipo) => { const m = new Map(); lista.filter(x => x.tipo === tipo).forEach(x => m.set(x.categoria_id, (m.get(x.categoria_id) || 0) + Number(x.importe))); return m; };
  const tabla = tipo => {
    const a = porCategoria(movs, tipo), b = porCategoria(movsAnt, tipo);
    const ids = [...new Set([...a.keys(), ...b.keys()])];
    const filas = ids.map(id => ({ nombre: categoria(id)?.nombre || 'Sin categoría', actual: a.get(id) || 0, anterior: b.get(id) || 0 })).sort((x, y) => y.actual - x.actual || y.anterior - x.anterior);
    return { filas, actual: filas.reduce((s, f) => s + f.actual, 0), anterior: filas.reduce((s, f) => s + f.anterior, 0) };
  };
  const facturas = docs.filter(d => d.tipo === 'factura' && d.estado !== 'rectificada');
  const aMapa = filas => new Map(filas.map(f => [f.categoria_id, Number(f.importe)]));
  const real = new Map([...porCategoria(movs, 'ingreso'), ...porCategoria(movs, 'gasto')]);
  return {
    anio, ingresos: tabla('ingreso'), gastos: tabla('gasto'), saldos, memo,
    real, presActual: aMapa(presActual), presSig: aMapa(presSig),
    subs: subs.map(s => ({ ...s, cobrado: ex.cobrado(s.id), justificado: ex.justificado(s.id) })),
    facturacion: { emitidas: facturas.length, total: facturas.reduce((a, d) => a + Number(d.total), 0),
      pendiente: facturas.filter(d => d.estado === 'emitida').reduce((a, d) => a + Number(d.total), 0) },
    provisional: hoy() <= fin,
  };
}
const variacion = (a, b) => (b ? `${a >= b ? '+' : ''}${Math.round(((a - b) / Math.abs(b)) * 100)} %` : '—');
const pctCumplido = (real, previsto) => (previsto ? `${Math.round((real / previsto) * 100)} %` : '—');
const filasEjecucion = (D, tipo) => E.categorias.filter(c => c.tipo === tipo && (D.presActual.has(c.id) || D.real.has(c.id)))
  .map(c => ({ nombre: c.nombre, prev: D.presActual.get(c.id) || 0, real: D.real.get(c.id) || 0 }));
const categoriasPresupuesto = (D, tipo) => E.categorias.filter(c => c.tipo === tipo && (c.activa || D.real.has(c.id) || D.presSig.has(c.id)));

async function vistaMemoria() {
  const v = $('#vista'), anio = E.ejercicio;
  v.innerHTML = esqueleto(6);
  let D;
  try { D = await datosMemoria(anio); } catch (e) { return errorVista(v, e, vistaMemoria); }
  const ed = puedeEditar();
  const presidente = D.memo?.presidente ?? E.perfiles.find(p => p.rol === 'admin' && p.activo)?.nombre ?? '';
  const tesorero = D.memo?.tesorero ?? E.perfiles.find(p => p.rol === 'tesorero' && p.activo)?.nombre ?? '';
  const tablaCat = (t, titulo) => `<table class="tabla-memoria"><caption class="sr">${titulo}</caption>
    <thead><tr><th scope="col">${titulo}</th><th scope="col">${anio}</th><th scope="col">${anio - 1}</th><th scope="col">Variación</th></tr></thead>
    <tbody>${t.filas.length ? t.filas.map(f => `<tr><td>${esc(f.nombre)}</td><td class="num">${eur(f.actual)}</td><td class="num muted">${eur(f.anterior)}</td><td class="num muted">${variacion(f.actual, f.anterior)}</td></tr>`).join('')
      : '<tr><td colspan="4" class="muted">Sin apuntes</td></tr>'}</tbody>
    <tfoot><tr><th scope="row">Total</th><td class="num"><strong>${eur(t.actual)}</strong></td><td class="num muted">${eur(t.anterior)}</td><td class="num muted">${variacion(t.actual, t.anterior)}</td></tr></tfoot></table>`;
  const res = D.ingresos.actual - D.gastos.actual, resAnt = D.ingresos.anterior - D.gastos.anterior;
  // Presupuesto: ejecución del de este año (si existe) y previsión del siguiente
  const numEjec = 7, numPres = D.presActual.size ? 8 : 7, numCom = numPres + 1;
  const tablaEjec = (tipo, titulo) => {
    const filas = filasEjecucion(D, tipo);
    const tp = filas.reduce((a, f) => a + f.prev, 0), tr = filas.reduce((a, f) => a + f.real, 0);
    return `<table class="tabla-memoria tabla-ejecucion"><caption class="sr">${titulo}: previsto frente a real</caption>
      <thead><tr><th scope="col">${titulo}</th><th scope="col">Previsto</th><th scope="col">Real</th><th scope="col">Cumplido</th></tr></thead>
      <tbody>${filas.map(f => `<tr><td>${esc(f.nombre)}</td><td class="num">${eur(f.prev)}</td><td class="num">${eur(f.real)}</td><td class="num muted">${pctCumplido(f.real, f.prev)}</td></tr>`).join('')}</tbody>
      <tfoot><tr><th scope="row">Total</th><td class="num"><strong>${eur(tp)}</strong></td><td class="num"><strong>${eur(tr)}</strong></td><td class="num muted">${pctCumplido(tr, tp)}</td></tr></tfoot></table>`;
  };
  const tablaPres = (tipo, titulo) => `<table class="tabla-memoria tabla-presupuesto"><caption class="sr">${titulo} previstos para ${anio + 1}</caption>
    <thead><tr><th scope="col">${titulo}</th><th scope="col">Real ${anio}</th><th scope="col">Previsto ${anio + 1}</th></tr></thead>
    <tbody>${categoriasPresupuesto(D, tipo).map(c => `<tr><td>${esc(c.nombre)}</td><td class="num muted">${eur(D.real.get(c.id) || 0)}</td>
      <td><input class="input-tabla num" inputmode="decimal" data-pres="${c.id}" data-tipo="${tipo}" placeholder="—" aria-label="Previsto ${anio + 1}: ${esc(c.nombre)}"
        value="${D.presSig.has(c.id) ? numInput(D.presSig.get(c.id)) : ''}" ${ed ? '' : 'readonly'}></td></tr>`).join('')}</tbody>
    <tfoot><tr><th scope="row">Total</th><td class="num muted">${eur(tipo === 'ingreso' ? D.ingresos.actual : D.gastos.actual)}</td><td class="num"><strong data-total-pres="${tipo}"></strong></td></tr></tfoot></table>`;
  v.innerHTML = `
    <div class="encabezado-vista no-imprimir"><a class="btn btn-texto" href="#inicio">← Inicio</a></div>
    <div class="encabezado-vista"><h1>Memoria económica ${anio}</h1>
      <button type="button" class="btn btn-icono no-imprimir" id="b-mem-imprimir" aria-label="Imprimir la memoria">${ico('imprimir')}</button>
      <button type="button" class="btn btn-primario no-imprimir" id="b-mem-pdf">${ico('descargar')} Descargar PDF</button></div>
    <p class="muted">${esc(E.ajustes?.nombre || '')}${D.provisional ? ` · Datos provisionales a ${fecha(hoy())}: el año aún no ha terminado.` : ''}</p>

    <section class="seccion" aria-labelledby="m-res"><h2 id="m-res">1. Resultado del año</h2>
      <div class="rejilla rejilla-3" style="margin-top:var(--space-3)">
        <div class="tarjeta kpi"><span class="muted pequeno">Ingresos</span><span class="cifra num positivo">${eur(D.ingresos.actual)}</span><span class="muted pequeno">${anio - 1}: ${eur(D.ingresos.anterior)}</span></div>
        <div class="tarjeta kpi"><span class="muted pequeno">Gastos</span><span class="cifra num negativo">${eur(D.gastos.actual)}</span><span class="muted pequeno">${anio - 1}: ${eur(D.gastos.anterior)}</span></div>
        <div class="tarjeta kpi"><span class="muted pequeno">${res >= 0 ? 'Superávit' : 'Déficit'}</span><span class="cifra num ${res >= 0 ? 'positivo' : 'negativo'}">${eur(res)}</span><span class="muted pequeno">${anio - 1}: ${eur(resAnt)}</span></div>
      </div></section>
    <section class="seccion" aria-labelledby="m-ing"><h2 id="m-ing">2. Ingresos por categoría</h2>${tablaCat(D.ingresos, 'Ingresos')}</section>
    <section class="seccion" aria-labelledby="m-gas"><h2 id="m-gas">3. Gastos por categoría</h2>${tablaCat(D.gastos, 'Gastos')}</section>
    <section class="seccion" aria-labelledby="m-tes"><h2 id="m-tes">4. Tesorería</h2>
      ${!D.saldos.length ? `<p class="muted">No hay cuentas de caja o banco con saldo en ${anio}. Se añaden en Tesorería con su saldo inicial.</p>` : `<table class="tabla-memoria"><caption class="sr">Saldos de caja y bancos</caption>
        <thead><tr><th scope="col">Cuenta</th><th scope="col">1 de enero</th><th scope="col">31 de diciembre</th><th scope="col">Diferencia</th></tr></thead>
        <tbody>${D.saldos.map(s => `<tr><td>${esc(s.nombre)}${s.abierta ? `<br><span class="muted pequeno">Saldo inicial a ${fecha(s.abierta)}</span>` : ''}</td><td class="num">${eur(s.inicio)}</td><td class="num">${eur(s.fin)}</td><td class="num muted">${eur(s.fin - s.inicio)}</td></tr>`).join('')}</tbody>
        <tfoot><tr><th scope="row">Total</th><td class="num"><strong>${eur(D.saldos.reduce((a, s) => a + s.inicio, 0))}</strong></td><td class="num"><strong>${eur(D.saldos.reduce((a, s) => a + s.fin, 0))}</strong></td>
          <td class="num muted">${eur(D.saldos.reduce((a, s) => a + s.fin - s.inicio, 0))}</td></tr></tfoot></table>`}</section>
    <section class="seccion" aria-labelledby="m-sub"><h2 id="m-sub">5. Subvenciones</h2>
      ${D.subs.length ? `<table class="tabla-memoria"><caption class="sr">Subvenciones del año</caption>
        <thead><tr><th scope="col">Subvención</th><th scope="col">Concedido</th><th scope="col">Cobrado</th><th scope="col">Estado</th></tr></thead>
        <tbody>${D.subs.map(s => `<tr><td>${esc(s.convocatoria)}<br><span class="muted pequeno">${esc(s.organismo)}</span></td><td class="num">${s.concedido != null ? eur(s.concedido) : '—'}</td>
          <td class="num">${eur(s.cobrado)}</td><td>${ESTADOS_SUB[s.estado][0]}</td></tr>`).join('')}</tbody></table>` : `<p class="muted">No hay subvenciones de ${anio}.</p>`}</section>
    <section class="seccion" aria-labelledby="m-fac"><h2 id="m-fac">6. Facturación</h2>
      <p>${D.facturacion.emitidas ? `${D.facturacion.emitidas} ${D.facturacion.emitidas === 1 ? 'factura emitida' : 'facturas emitidas'} por <strong class="num">${eur(D.facturacion.total)}</strong>${D.facturacion.pendiente ? `, de las que quedan <strong class="num">${eur(D.facturacion.pendiente)}</strong> pendientes de cobro` : ', todas cobradas'}.` : `No se emitieron facturas en ${anio}.`}</p></section>
    ${D.presActual.size ? `<section class="seccion" aria-labelledby="m-ejec"><h2 id="m-ejec">${numEjec}. Presupuesto ${anio}: previsto frente a real</h2>
      <p class="muted pequeno" style="margin-top:var(--space-1)">El presupuesto que aprobó la asamblea comparado con lo que se ha ingresado y gastado.</p>
      ${tablaEjec('ingreso', 'Ingresos')}${tablaEjec('gasto', 'Gastos')}</section>` : ''}
    <form class="seccion" id="f-pres" aria-labelledby="m-pres" novalidate><h2 id="m-pres">${numPres}. Presupuesto para ${anio + 1}</h2>
      <p class="muted pequeno" style="margin:var(--space-1) 0 var(--space-2)">Previsión de ingresos y gastos para presentar a la asamblea. Deja en blanco lo que no se prevea.</p>
      ${ed ? `<button type="button" class="btn btn-texto no-imprimir" id="b-pres-copiar">Partir de lo real de ${anio}</button>` : ''}
      ${tablaPres('ingreso', 'Ingresos')}${tablaPres('gasto', 'Gastos')}
      <dl class="totales" id="pres-totales" aria-live="polite" style="margin-top:var(--space-3)"></dl>
      <p class="error" id="pres-err" role="alert" hidden></p>
      ${ed ? `<div style="margin-top:var(--space-3)"><button type="submit" class="btn no-imprimir">Guardar presupuesto</button></div>` : ''}
    </form>
    <form class="seccion" id="f-mem" aria-labelledby="m-com" novalidate><h2 id="m-com">${numCom}. Comentarios</h2>
      <div class="campo" style="margin-top:var(--space-3)"><label for="m-comentarios">Comentarios para la asamblea</label>
        <textarea id="m-comentarios" rows="6" maxlength="4000" ${ed ? '' : 'readonly'} aria-describedby="m-comentarios-ayuda">${esc(D.memo?.comentarios || '')}</textarea>
        <p class="ayuda" id="m-comentarios-ayuda">Por ejemplo: actividades del año, por qué subió algún gasto, previsiones para el próximo año…</p></div>
      <div class="fila-campos" style="margin-top:var(--space-3)">
        <div class="campo"><label for="m-presidente">Presidente</label><input id="m-presidente" maxlength="100" value="${esc(presidente)}" ${ed ? '' : 'readonly'}></div>
        <div class="campo"><label for="m-tesorero">Tesorero</label><input id="m-tesorero" maxlength="100" value="${esc(tesorero)}" ${ed ? '' : 'readonly'}></div>
      </div>
      ${ed ? `<div style="margin-top:var(--space-3)"><button type="submit" class="btn no-imprimir">Guardar comentarios</button></div>` : ''}
    </form>`;
  const leer = () => ({ ejercicio: anio, comentarios: $('#m-comentarios').value.trim() || null, presidente: $('#m-presidente').value.trim() || null, tesorero: $('#m-tesorero').value.trim() || null });
  const guardar = async () => { await q(sb.from('memorias').upsert({ ...leer(), actualizado_en: new Date().toISOString() })); };
  $('#f-mem').addEventListener('submit', async e => {
    e.preventDefault();
    await conBoton(e.submitter, async () => { try { await guardar(); tostada('Comentarios guardados'); } catch (err) { tostada(mensajeError(err), { error: true }); } });
  });
  // Presupuesto del año siguiente: totales en vivo, copiar lo real y guardar
  const fp = $('#f-pres');
  const leerPres = () => {
    const mapa = new Map(); let malo = null;
    $$('[data-pres]', fp).forEach(i => {
      const t = i.value.trim(); if (!t) { i.removeAttribute('aria-invalid'); return; }
      const n = parseImporte(t);
      if (!(n >= 0)) { i.setAttribute('aria-invalid', 'true'); malo = malo || i; } else { i.removeAttribute('aria-invalid'); if (n > 0) mapa.set(i.dataset.pres, n); }
    });
    return { mapa, malo };
  };
  const totalesPres = () => {
    const { mapa } = leerPres();
    const suma = tipo => $$(`[data-pres][data-tipo="${tipo}"]`, fp).reduce((a, i) => a + (mapa.get(i.dataset.pres) || 0), 0);
    const ti = suma('ingreso'), tg = suma('gasto');
    $('[data-total-pres="ingreso"]', fp).textContent = eur(ti); $('[data-total-pres="gasto"]', fp).textContent = eur(tg);
    $('#pres-totales', fp).innerHTML = `<dt>Ingresos previstos</dt><dd class="num">${eur(ti)}</dd><dt>Gastos previstos</dt><dd class="num">${eur(tg)}</dd>
      <dt class="total">${ti - tg >= 0 ? 'Superávit previsto' : 'Déficit previsto'}</dt><dd class="num total ${ti - tg >= 0 ? 'positivo' : 'negativo'}">${eur(ti - tg)}</dd>`;
  };
  fp.addEventListener('input', totalesPres);
  fp.addEventListener('focusout', e => { const i = e.target; if (i.dataset?.pres && i.value.trim()) { const n = parseImporte(i.value); if (n >= 0) i.value = numInput(n); } });
  totalesPres();
  $('#b-pres-copiar')?.addEventListener('click', async () => {
    const hayDatos = $$('[data-pres]', fp).some(i => i.value.trim());
    if (hayDatos && !await confirmar({ titulo: `¿Partir de lo real de ${anio}?`, texto: 'Se sustituirán los importes que ya hayas escrito por lo ingresado y gastado este año. Después puedes ajustarlos.', boton: 'Rellenar con lo real' })) return;
    $$('[data-pres]', fp).forEach(i => { const r = D.real.get(i.dataset.pres); i.value = r ? numInput(r) : ''; });
    totalesPres(); tostada('Rellenado con lo real. Ajusta lo que vaya a cambiar y guarda.');
  });
  fp.addEventListener('submit', async e => {
    e.preventDefault();
    const { mapa, malo } = leerPres(), err = $('#pres-err', fp);
    err.hidden = !malo; err.innerHTML = malo ? `${ico('alerta', 'ico-s')} Revisa los importes marcados: escribe solo números, por ejemplo 1.500,00.` : '';
    if (malo) return malo.focus();
    await conBoton(e.submitter, async () => {
      try {
        const sobran = [...D.presSig.keys()].filter(id => !mapa.has(id));
        if (mapa.size) await q(sb.from('presupuesto_lineas').upsert([...mapa].map(([categoria_id, importe]) => ({ ejercicio: anio + 1, categoria_id, importe, actualizado_en: new Date().toISOString() }))));
        if (sobran.length) await q(sb.from('presupuesto_lineas').delete().eq('ejercicio', anio + 1).in('categoria_id', sobran));
        D.presSig = mapa; tostada(`Presupuesto para ${anio + 1} guardado`);
      } catch (er) { tostada(mensajeError(er), { error: true }); }
    });
  });
  $('#b-mem-imprimir').addEventListener('click', () => print());
  $('#b-mem-pdf').addEventListener('click', e => conBoton(e.currentTarget, async () => {
    try {
      if (ed) await guardar().catch(() => {});
      descargar(`memoria-economica-${anio}.pdf`, await pdfMemoria({ ...D, memo: leer(), presSig: leerPres().mapa }), 'application/pdf');
    } catch (err) { tostada('No se pudo crear el PDF. ' + mensajeError(err), { error: true }); }
  }));
}

async function pdfMemoria(D) {
  const anio = D.anio;
  const c = await nuevoPdfListado(`Memoria económica ${anio}`, D.provisional ? `Datos provisionales a ${fechaLarga(hoy())}.` : `Ejercicio del 1 de enero al 31 de diciembre de ${anio}.`);
  const res = D.ingresos.actual - D.gastos.actual, resAnt = D.ingresos.anterior - D.gastos.anterior;
  const cols4 = t => [{ t, w: 82 }, { t: String(anio), w: 34, a: 'right' }, { t: String(anio - 1), w: 34, a: 'right' }, { t: 'Variación', w: 28, a: 'right' }];
  c.seccion('1. Resultado del año');
  c.tabla(cols4('Concepto'), [
    ['Ingresos', eur(D.ingresos.actual), eur(D.ingresos.anterior), variacion(D.ingresos.actual, D.ingresos.anterior)],
    ['Gastos', eur(D.gastos.actual), eur(D.gastos.anterior), variacion(D.gastos.actual, D.gastos.anterior)],
    [res >= 0 ? 'Superávit' : 'Déficit', eur(res), eur(resAnt), ''],
  ], { totalUltima: true });
  const cat = t => [...t.filas.map(f => [f.nombre, eur(f.actual), eur(f.anterior), variacion(f.actual, f.anterior)]), ['Total', eur(t.actual), eur(t.anterior), variacion(t.actual, t.anterior)]];
  c.seccion('2. Ingresos por categoría'); c.tabla(cols4('Categoría'), cat(D.ingresos), { totalUltima: true });
  c.seccion('3. Gastos por categoría'); c.tabla(cols4('Categoría'), cat(D.gastos), { totalUltima: true });
  c.seccion('4. Tesorería');
  const tIni = D.saldos.reduce((a, s) => a + s.inicio, 0), tFin = D.saldos.reduce((a, s) => a + s.fin, 0);
  if (!D.saldos.length) c.parrafo(`No hay cuentas de caja o banco con saldo en ${anio}.`);
  else c.tabla([{ t: 'Cuenta', w: 82 }, { t: '1 de enero', w: 34, a: 'right' }, { t: '31 de diciembre', w: 34, a: 'right' }, { t: 'Diferencia', w: 28, a: 'right' }],
    [...D.saldos.map(s => [s.nombre + (s.abierta ? ` (saldo inicial a ${fecha(s.abierta)})` : ''), eur(s.inicio), eur(s.fin), eur(s.fin - s.inicio)]), ['Total', eur(tIni), eur(tFin), eur(tFin - tIni)]], { totalUltima: true });
  c.seccion('5. Subvenciones');
  if (D.subs.length) c.tabla([{ t: 'Subvención', w: 92 }, { t: 'Concedido', w: 30, a: 'right' }, { t: 'Cobrado', w: 30, a: 'right' }, { t: 'Estado', w: 26 }],
    D.subs.map(s => [`${s.convocatoria} (${s.organismo})`, s.concedido != null ? eur(s.concedido) : '—', eur(s.cobrado), ESTADOS_SUB[s.estado][0]]));
  else c.parrafo(`No hay subvenciones de ${anio}.`);
  c.seccion('6. Facturación');
  c.parrafo(D.facturacion.emitidas ? `${D.facturacion.emitidas} ${D.facturacion.emitidas === 1 ? 'factura emitida' : 'facturas emitidas'} por ${eur(D.facturacion.total)}${D.facturacion.pendiente ? `, de las que quedan ${eur(D.facturacion.pendiente)} pendientes de cobro` : ', todas cobradas'}.` : `No se emitieron facturas en ${anio}.`);
  let num = 7;
  if (D.presActual.size) {
    c.seccion(`${num++}. Presupuesto ${anio}: previsto frente a real`);
    [['ingreso', 'Ingresos'], ['gasto', 'Gastos']].forEach(([tipo, titulo]) => {
      const filas = filasEjecucion(D, tipo), tp = filas.reduce((a, f) => a + f.prev, 0), tr = filas.reduce((a, f) => a + f.real, 0);
      c.tabla([{ t: titulo, w: 82 }, { t: 'Previsto', w: 34, a: 'right' }, { t: 'Real', w: 34, a: 'right' }, { t: 'Cumplido', w: 28, a: 'right' }],
        [...filas.map(f => [f.nombre, eur(f.prev), eur(f.real), pctCumplido(f.real, f.prev)]), ['Total', eur(tp), eur(tr), pctCumplido(tr, tp)]], { totalUltima: true });
    });
  }
  if (D.presSig.size) {
    c.seccion(`${num++}. Presupuesto para ${anio + 1}`);
    let ti = 0, tg = 0;
    [['ingreso', 'Ingresos'], ['gasto', 'Gastos']].forEach(([tipo, titulo]) => {
      const cats = categoriasPresupuesto(D, tipo).filter(x => D.presSig.has(x.id) || D.real.has(x.id));
      const tp = cats.reduce((a, x) => a + (D.presSig.get(x.id) || 0), 0), tr = cats.reduce((a, x) => a + (D.real.get(x.id) || 0), 0);
      if (tipo === 'ingreso') ti = tp; else tg = tp;
      c.tabla([{ t: titulo, w: 98 }, { t: `Real ${anio}`, w: 40, a: 'right' }, { t: `Previsto ${anio + 1}`, w: 40, a: 'right' }],
        [...cats.map(x => [x.nombre, eur(D.real.get(x.id) || 0), D.presSig.has(x.id) ? eur(D.presSig.get(x.id)) : '—']), ['Total', eur(tr), eur(tp)]], { totalUltima: true });
    });
    c.parrafo(`Ingresos previstos: ${eur(ti)}. Gastos previstos: ${eur(tg)}. ${ti - tg >= 0 ? 'Superávit' : 'Déficit'} previsto: ${eur(ti - tg)}.`, { b: true });
  }
  if (D.memo?.comentarios) { c.seccion(`${num++}. Comentarios`); c.parrafo(D.memo.comentarios); }
  c.saltoSi(45); c.y += 18;
  const w = (c.ancho - 20) / 2;
  [[D.memo?.presidente, 'El presidente'], [D.memo?.tesorero, 'El tesorero']].forEach(([nombre, cargo], i) => {
    const x = c.M + i * (w + 20);
    c.pdf.setDrawColor(150, 150, 145); c.pdf.line(x, c.y, x + w, c.y);
    c.txt(cargo, x + w / 2, c.y + 5, { s: 9, c: c.GRIS, a: 'center' });
    if (nombre) c.txt(nombre, x + w / 2, c.y + 10, { s: 10, a: 'center' });
  });
  c.y += 16;
  c.txt(`En ${E.ajustes?.localidad || '…'}, a ${fechaLarga(hoy())}.`, c.AN - c.M, c.y, { a: 'right', s: 9.5 });
  return c.cerrar();
}

// Modo de pruebas: borrar todo y empezar limpio (solo administrador)
function seccionModoPruebas(a) {
  if (!a.modo_pruebas) return `<section class="seccion tarjeta" aria-labelledby="t-pruebas"><h2 id="t-pruebas">Puesta en marcha</h2>
    <p class="muted">La contabilidad está en uso real desde el ${fecha(a.en_uso_desde)}. Los apuntes y facturas ya no se pueden borrar: solo anular o rectificar.</p></section>`;
  return `<section class="seccion tarjeta zona-pruebas" aria-labelledby="t-pruebas"><h2 id="t-pruebas">Pruebas y puesta en marcha</h2>
    <p style="max-width:70ch">Ahora estáis en <strong>modo de pruebas</strong>. Podéis apuntar, hacer facturas y practicar todo lo que queráis, y después borrarlo.</p>
    <p class="muted pequeno" style="margin:var(--space-2) 0 var(--space-4);max-width:70ch">Se borran apuntes, justificantes, cuadres, presupuestos, facturas, clientes e historial, y la numeración vuelve a empezar.
      Se conservan las personas con acceso, las cuentas, las categorías, el logo y los datos de la coral.</p>
    <div style="display:flex;flex-wrap:wrap;gap:var(--space-2)">
      <button type="button" class="btn" data-borrar-pruebas="borrar">${ico('papelera')} Borrar los datos de prueba</button>
      <button type="button" class="btn btn-peligro" data-borrar-pruebas="empezar">${ico('ok')} Empezar de verdad</button>
    </div>
    <p class="muted pequeno" style="margin-top:var(--space-3);max-width:70ch">«Empezar de verdad» borra los datos de prueba y desactiva este modo para siempre. Hazlo el 1 de enero, y antes revisa en Tesorería el saldo inicial de cada cuenta.</p>
  </section>`;
}

function borrarDatosPrueba(empezar) {
  const d = dialogo({
    titulo: empezar ? '¿Empezar de verdad?' : '¿Borrar los datos de prueba?', cerrarFuera: false,
    cuerpo: `<form class="formulario" id="f-borrar" novalidate>
      <p>${empezar ? 'Se borrarán todos los datos de prueba y la contabilidad pasará a <strong>uso real</strong>. Desde ese momento no se podrá volver a borrar nada.'
        : 'Se borrarán todos los apuntes, justificantes, presupuestos, facturas, clientes e historial. Las cuentas, categorías y personas con acceso se conservan.'}</p>
      <div class="aviso aviso-aviso">${ico('alerta')}<p>Esto no se puede deshacer.</p></div>
      <div class="campo"><label for="br-texto">Para confirmar, escribe BORRAR</label>
        <input id="br-texto" autocomplete="off" autocapitalize="characters" aria-describedby="br-texto-err"><p class="error" id="br-texto-err" hidden></p></div>
      <div class="aviso aviso-error" id="br-error" role="alert" hidden></div></form>`,
    pie: `<button type="button" class="btn" data-cerrar>Cancelar</button>
      <button type="submit" form="f-borrar" class="btn btn-peligro">${empezar ? 'Borrar y empezar de verdad' : 'Borrar los datos de prueba'}</button>`,
  });
  const inp = $('#br-texto', d);
  $('#f-borrar', d).addEventListener('submit', async e => {
    e.preventDefault();
    if (inp.value.trim().toUpperCase() !== 'BORRAR') { mostrarError(inp, 'Escribe BORRAR, en mayúsculas o minúsculas.'); return inp.focus(); }
    await conBoton(d.querySelector('[type=submit]'), async () => {
      try {
        const rutas = await q(sb.rpc('borrar_datos_prueba', { p_empezar: empezar }));
        for (let i = 0; i < rutas.length; i += 100) await sb.storage.from('justificantes').remove(rutas.slice(i, i + 100));
        d.close();
        E.ejercicio = new Date().getFullYear();
        await cargarMaestros(); vistaAjustes();
        tostada(empezar ? 'Listo: la contabilidad está en uso real' : 'Datos de prueba borrados. Podéis seguir practicando.');
      } catch (err) { const box = $('#br-error', d); box.innerHTML = `${ico('alerta')}<p>${esc(mensajeError(err))}</p>`; box.hidden = false; }
    });
  });
  inp.focus();
}

// Ajustes de presupuestos y facturas
function seccionAjustesFacturas(a, ed) {
  const ro = ed ? '' : 'readonly';
  return `<form class="seccion tarjeta formulario" id="f-fact" novalidate aria-labelledby="t-fact">
    <h2 id="t-fact">Presupuestos y facturas</h2>
    <div class="campo"><span class="etiqueta-campo">Logo</span>
      <div class="logo-ajustes"><div class="logo-prev" id="aj-logo-prev">${a.logo_ruta ? '<div class="esqueleto esq-campo"></div>' : '<span class="muted pequeno">Sin logo</span>'}</div>
        ${ed ? `<label class="btn" for="aj-logo">${ico('camara')} ${a.logo_ruta ? 'Cambiar logo' : 'Subir logo'}</label>
          <input type="file" id="aj-logo" accept="image/png,image/jpeg,image/webp" class="sr">
          ${a.logo_ruta ? '<button type="button" class="btn btn-texto" id="aj-logo-quitar">Quitar logo</button>' : ''}` : ''}</div></div>
    <div class="rejilla rejilla-2">
      <div class="campo"><label for="aj-iva">IVA por defecto</label><select id="aj-iva" ${ed ? '' : 'disabled'}>
        ${IVAS.map(([v, t]) => `<option value="${v}" ${Number(a.iva_pct) === v ? 'selected' : ''}>${t}</option>`).join('')}</select></div>
      <div class="campo"><label for="aj-validez">Validez de los presupuestos (días)</label>
        <input id="aj-validez" type="number" inputmode="numeric" min="1" max="365" value="${a.validez_dias || 30}" ${ro}></div>
    </div>
    <div class="campo"><label for="aj-ivatexto">Texto legal cuando no lleva IVA</label>
      <textarea id="aj-ivatexto" maxlength="400" ${ro} aria-describedby="aj-ivatexto-ayuda">${esc(a.iva_texto || '')}</textarea>
      <p class="ayuda" id="aj-ivatexto-ayuda">Confirmad con la gestoría qué artículo de exención corresponde a la coral y escribidlo aquí.</p></div>
    <div class="campo"><label for="aj-conceptos">Conceptos frecuentes</label>
      <textarea id="aj-conceptos" rows="4" maxlength="2000" ${ro} aria-describedby="aj-conceptos-ayuda">${esc(a.conceptos_frecuentes || '')}</textarea>
      <p class="ayuda" id="aj-conceptos-ayuda">Uno por línea. Salen como sugerencias al escribir un concepto.</p></div>
    <div class="campo"><label for="aj-pie">Pie de página</label><input id="aj-pie" maxlength="200" value="${esc(a.pie_documentos || '')}" ${ro} aria-describedby="aj-pie-ayuda">
      <p class="ayuda" id="aj-pie-ayuda">Opcional. Por ejemplo, el número de inscripción en el registro de asociaciones.</p></div>
    ${ed ? '<div><button type="submit" class="btn btn-primario">Guardar ajustes de facturas</button></div>' : ''}
  </form>`;
}

function conectarAjustesFacturas(a) {
  if (a.logo_ruta) logoActual().then(l => { const p = $('#aj-logo-prev'); if (p && l) p.innerHTML = `<img src="${l.data}" alt="Logo actual de la coral">`; })
    .catch(() => { const p = $('#aj-logo-prev'); if (p) p.innerHTML = '<span class="muted pequeno">No se pudo cargar el logo</span>'; });
  $('#aj-logo')?.addEventListener('change', async e => {
    const archivo = e.target.files[0]; e.target.value = '';
    if (!archivo) return;
    try {
      const bmp = await createImageBitmap(archivo).catch(() => { throw new ErrorHumano('No se puede leer esa imagen. Usa un PNG o JPG.'); });
      const escala = Math.min(1, 600 / Math.max(bmp.width, bmp.height));
      const lienzo = Object.assign(document.createElement('canvas'), { width: Math.round(bmp.width * escala), height: Math.round(bmp.height * escala) });
      lienzo.getContext('2d').drawImage(bmp, 0, 0, lienzo.width, lienzo.height);
      const blob = await new Promise(ok => lienzo.toBlob(ok, 'image/png'));
      const ruta = `ajustes/logo-${crypto.randomUUID().slice(0, 8)}.png`;
      await q(sb.storage.from('justificantes').upload(ruta, blob, { contentType: 'image/png' }));
      await q(sb.from('ajustes').update({ logo_ruta: ruta }).eq('id', 1));
      if (a.logo_ruta) sb.storage.from('justificantes').remove([a.logo_ruta]);
      tostada('Logo guardado'); vistaAjustes();
    } catch (err) { tostada(mensajeError(err), { error: true }); }
  });
  $('#aj-logo-quitar')?.addEventListener('click', async () => {
    if (!await confirmar({ titulo: '¿Quitar el logo?', texto: 'Los documentos saldrán sin logo. Puedes subir otro cuando quieras.', boton: 'Quitar logo' })) return;
    try { await q(sb.from('ajustes').update({ logo_ruta: null }).eq('id', 1)); sb.storage.from('justificantes').remove([a.logo_ruta]); tostada('Logo quitado'); vistaAjustes(); }
    catch (err) { tostada(mensajeError(err), { error: true }); }
  });
  $('#f-fact')?.addEventListener('submit', async e => {
    e.preventDefault();
    const dias = Number($('#aj-validez').value);
    if (!(dias >= 1 && dias <= 365)) { tostada('La validez debe ser entre 1 y 365 días.', { error: true }); return $('#aj-validez').focus(); }
    const datos = { iva_pct: Number($('#aj-iva').value), validez_dias: dias, iva_texto: $('#aj-ivatexto').value.trim() || null,
      conceptos_frecuentes: $('#aj-conceptos').value.trim() || null, pie_documentos: $('#aj-pie').value.trim() || null };
    await conBoton(e.submitter, async () => {
      try { await q(sb.from('ajustes').update(datos).eq('id', 1)); Object.assign(E.ajustes, datos); tostada('Ajustes de facturas guardados'); }
      catch (err) { tostada(mensajeError(err), { error: true }); }
    });
  });
}

async function arrancar() {
  if (!configurado) return pantallaSinConfigurar();
  const { data: { session } } = await sb.auth.getSession();
  if (session) await entrar(session); else await pantallaAcceso();
  sb.auth.onAuthStateChange(evento => {
    if (evento === 'SIGNED_OUT' && E.perfil) { E.perfil = null; pantallaAcceso('Tu sesión se ha cerrado. Vuelve a entrar.'); }
  });
}
arrancar();
