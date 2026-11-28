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

function pantallaSinConfigurar() {
  app.innerHTML = `<div class="acceso"><div class="tarjeta">
    <div class="logo">${ico('musica')}<h1>Cuentas de la coral</h1></div>
    <div class="aviso aviso-info">${ico('info')}<p>La app todavía no está conectada a su base de datos. Falta rellenar <code>config.js</code>.</p></div>
  </div></div>`;
}

async function pantallaAcceso(mensaje) {
  let hayAdmin = true;
  try { hayAdmin = (await llamarUsuarios({ accion: 'estado' })).hayAdmin; } catch { /* si falla, se muestra el acceso normal */ }
  if (!hayAdmin) return pantallaPrimerAdmin();

  app.innerHTML = `<main class="acceso"><form class="tarjeta" id="f-acceso" novalidate>
    <div class="logo">${ico('musica')}<div><h1>Cuentas de la coral</h1><p class="muted pequeno">${esc(E.ajustes?.nombre || 'Coral Villa de Mengíbar')}</p></div></div>
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
    <div class="logo">${ico('musica')}<h1>Configura las cuentas de la coral</h1></div>
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
  { ruta: 'ajustes', nombre: 'Ajustes', ico: 'ajustes' },
];

function pintarMarco() {
  app.innerHTML = `
    <header class="cabecera">
      <a class="marca" href="#inicio" style="color:inherit;text-decoration:none">${ico('musica')}<span>Cuentas de la coral</span></a>
      <label class="sr" for="sel-ejercicio">Año</label>
      <select id="sel-ejercicio" class="no-imprimir"></select>
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

const VISTAS = { inicio: vistaInicio, libro: vistaLibro, tesoreria: vistaTesoreria, facturas: vistaFacturas, ajustes: vistaAjustes, historial: vistaHistorial };
let rutaAnterior = null;
function enrutar() {
  const [ruta, qs] = location.hash.slice(1).split('?');
  const nombre = VISTAS[ruta] ? ruta : 'inicio';
  const pestana = nombre === 'historial' ? 'ajustes' : nombre;
  $$('.pestanas a').forEach(a => {
    if (a.dataset.ruta === pestana) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
  document.title = `${PESTANAS.find(p => p.ruta === pestana)?.nombre} · Cuentas de la coral`;
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
  let pendientes = [];
  try {
    [, , pendientes] = await Promise.all([cargarSaldos(), cargarMovs(),
      q(sb.from('documentos').select('id, total').eq('tipo', 'factura').eq('estado', 'emitida'))]);
  } catch (e) { return errorVista(v, e, vistaInicio); }
  const activas = E.cuentas.filter(c => c.activa);
  const total = activas.reduce((s, c) => s + Number(c.saldo), 0);
  const t = totales(E.movs);
  const sinJust = E.movs.filter(m => m.tipo === 'gasto' && !m.anulado && !m.njust).length;
  const hayBanco = E.cuentas.some(c => c.tipo === 'banco');

  v.innerHTML = `
    <div class="encabezado-vista"><h1>Resumen ${E.ejercicio}</h1></div>
    ${puedeEditar() ? `<div class="accion-principal">
      <button type="button" class="btn btn-primario btn-grande" data-a="nuevo" data-tipo="gasto">${ico('mas')} Apuntar gasto</button>
      <button type="button" class="btn btn-grande" data-a="nuevo" data-tipo="ingreso">${ico('mas')} Apuntar ingreso</button>
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
    const datos = Object.fromEntries(['nombre', 'cif', 'direccion', 'email', 'telefono', 'iban'].map(k => [k, $('#aj-' + k).value.trim() || null]));
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

function gestionarUsuario(p) {
  const d = dialogo({
    titulo: p.nombre,
    cuerpo: `<form class="formulario" id="f-gest" novalidate>
      <p class="muted">${esc(p.email)}</p>
      ${radiosRol('g-rol', p.rol)}
      <div class="aviso aviso-error" id="g-error" role="alert" hidden></div>
    </form>`,
    pie: `<button type="button" class="btn btn-texto izquierda" id="g-activo">${p.activo ? 'Quitar el acceso' : 'Devolver el acceso'}</button>
      <button type="button" class="btn" id="g-pass">${ico('llave')} Nueva contraseña</button>
      <button type="submit" form="f-gest" class="btn btn-primario">Guardar permiso</button>`,
  });
  const err = x => { const box = $('#g-error', d); box.innerHTML = `${ico('alerta')}<p>${esc(mensajeError(x))}</p>`; box.hidden = false; };
  $('#f-gest', d).addEventListener('submit', async e => {
    e.preventDefault();
    const rol = $('input[name="g-rol"]:checked', d).value;
    await conBoton(d.querySelector('[type=submit]'), async () => {
      try { await llamarUsuarios({ accion: 'cambiar', id: p.id, rol }); d.close(); await vistaAjustes(); tostada(`${p.nombre} ahora es ${ROLES[rol].nombre.toLowerCase()}`); }
      catch (x) { err(x); }
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
    const tablas = ['ajustes', 'cuentas', 'categorias', 'movimientos', 'justificantes', 'conciliaciones', 'clientes', 'documentos', 'perfiles', 'historial'];
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
  nombre: 'nombre', detalle: 'detalle', saldo_inicial: 'saldo inicial', fecha_inicial: 'fecha del saldo', activa: 'en uso', rol: 'permiso', activo: 'acceso' };
function valorLegible(k, v) {
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
  const ver = ['presupuestos', 'facturas', 'clientes'].includes(params.get('ver')) ? params.get('ver') : 'presupuestos';
  v.innerHTML = esqueleto(4);
  let docs, clientes;
  try {
    [docs, clientes] = await Promise.all([
      q(sb.from('documentos').select('*').eq('ejercicio', E.ejercicio).order('fecha', { ascending: false }).order('numero', { ascending: false })),
      q(sb.from('clientes').select('*').order('nombre')),
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
      ${pestana('presupuestos', 'Presupuestos', pres.length)}${pestana('facturas', 'Facturas', facs.length)}${pestana('clientes', 'Clientes', clientes.length)}</nav>
    ${contenido}`;
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
  const TINTA = [29, 29, 27], GRIS = [97, 97, 92], AZUL = [36, 64, 122], BLANCO = [255, 255, 255], LINEA = [220, 220, 214];
  const limpio = s => String(s ?? '').replace(/[  ]/g, ' ').replace(/−/g, '-');
  const euro = n => limpio(eur(n));
  const txt = (t, x, y, o = {}) => {
    pdf.setFont('helvetica', o.b ? 'bold' : 'normal'); pdf.setFontSize(o.s || 10); pdf.setTextColor(...(o.c || TINTA));
    pdf.text(limpio(t), x, y, { align: o.a || 'left' });
  };
  let y = M, xDatos = M;
  try {
    const logo = await logoActual();
    if (logo) { const h = 20, w = Math.min(42, h * logo.ratio); pdf.addImage(logo.data, logo.formato, M, y, w, h); xDatos = M + w + 6; }
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
    const mov = await sb.from('movimientos').select('numero, cuenta_id, fecha').eq('id', doc.movimiento_id).maybeSingle().then(r => r.data);
    cobroInfo = `<div class="aviso aviso-info">${ico('ok')}<p>Cobrada el ${fecha(doc.cobrada_en)}${mov ? ` en «${esc(cuenta(mov.cuenta_id)?.nombre || '')}». Es el apunte nº ${mov.numero} del libro` : ''}.</p>
      ${mov ? `<button type="button" class="btn btn-texto acciones" data-ver-mov="${doc.movimiento_id}">Ver apunte</button>` : ''}</div>`;
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
